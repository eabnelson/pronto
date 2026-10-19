// Pronto's bounded desktop-session helper. Credentials never cross RPC.
package main

import (
	"bufio"
	"bytes"
	"context"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/gorilla/websocket"
	"io"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"
)

//go:embed credential/LICENSE licenses/*
var licenses embed.FS

const protocol = 1

var outputMu sync.Mutex

func emit(v any)                          { outputMu.Lock(); defer outputMu.Unlock(); _ = json.NewEncoder(os.Stdout).Encode(v) }
func event(kind string, v map[string]any) { v["version"] = protocol; v["event"] = kind; emit(v) }
func health(state, reason string)         { event("health", map[string]any{"state": state, "reason": reason}) }

var safe = regexp.MustCompile(`^slack-[a-z0-9-]{1,80}$`)
var validTS = regexp.MustCompile(`^\d{10,16}\.\d{1,9}$`)

func safeError(err error) string {
	if safe.MatchString(err.Error()) {
		return err.Error()
	}
	return "slack-helper-failed"
}
func privateDirectory(directory string) error {
	absolute, err := filepath.Abs(directory)
	if err != nil {
		return err
	}
	current := "/"
	for _, part := range strings.Split(strings.TrimPrefix(absolute, "/"), "/") {
		current = filepath.Join(current, part)
		if err = os.Mkdir(current, 0700); err != nil && !os.IsExist(err) {
			return errors.New("slack-unsafe-directory")
		}
		stat, err := os.Lstat(current)
		if err != nil || !stat.IsDir() || stat.Mode()&os.ModeSymlink != 0 {
			return errors.New("slack-unsafe-directory")
		}
	}
	stat, err := os.Stat(absolute)
	if err != nil {
		return err
	}
	if info, ok := stat.Sys().(*syscall.Stat_t); !ok || info.Uid != uint32(os.Getuid()) {
		return errors.New("slack-unsafe-owner")
	}
	return os.Chmod(absolute, 0700)
}

type session struct {
	team, owner, token, cookie, label, memberLabel string
	verified                                       time.Time
}
type apiFailure struct {
	code   string
	status int
}

func (e *apiFailure) Error() string { return e.code }

type helper struct {
	mu                     sync.Mutex
	session                *session
	selected               map[string]bool
	observeUnselected      bool
	socket                 *websocket.Conn
	watchCancel            context.CancelFunc
	rateMu                 sync.Mutex
	lastCall, blockedUntil time.Time
	client                 *http.Client
	dial                   func(context.Context, string, http.Header) (*websocket.Conn, *http.Response, error)
}

func newHelper() *helper {
	dialer := &websocket.Dialer{HandshakeTimeout: 15 * time.Second}
	return &helper{selected: map[string]bool{}, client: &http.Client{Timeout: 20 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("slack-redirect-rejected") }}, dial: dialer.DialContext}
}
func str(v map[string]json.RawMessage, key string) string {
	var s string
	_ = json.Unmarshal(v[key], &s)
	return s
}
func (h *helper) call(ctx context.Context, s *session, method string, params map[string]any) (map[string]json.RawMessage, error) {
	allowed := map[string]bool{"auth.test": true, "rtm.connect": true, "users.conversations": true, "conversations.info": true, "users.info": true, "conversations.history": true, "conversations.replies": true, "chat.postMessage": true}
	if !allowed[method] {
		return nil, errors.New("slack-operation-rejected")
	}
	h.rateMu.Lock()
	wait := time.Until(h.lastCall.Add(500 * time.Millisecond))
	if until := time.Until(h.blockedUntil); until > wait {
		wait = until
	}
	if wait > 20*time.Second {
		h.rateMu.Unlock()
		return nil, errors.New("slack-throttled")
	}
	if wait > 0 {
		select {
		case <-ctx.Done():
			h.rateMu.Unlock()
			return nil, errors.New("slack-timeout")
		case <-time.After(wait):
		}
	}
	h.lastCall = time.Now()
	h.rateMu.Unlock()
	endpoint := "https://slack.com/api/" + method
	verb := http.MethodGet
	var body io.Reader
	if method == "chat.postMessage" {
		verb = http.MethodPost
		data, _ := json.Marshal(params)
		body = bytes.NewReader(data)
	} else {
		query := url.Values{}
		for k, v := range params {
			query.Set(k, fmt.Sprint(v))
		}
		endpoint += "?" + query.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, verb, endpoint, body)
	if err != nil {
		return nil, errors.New("slack-request-invalid")
	}
	req.Header.Set("Authorization", "Bearer "+s.token)
	req.Header.Set("Cookie", "d="+s.cookie)
	req.Header.Set("Content-Type", "application/json; charset=utf-8")
	req.Header.Set("User-Agent", "Pronto-Slack/1")
	response, err := h.client.Do(req)
	if err != nil {
		return nil, errors.New("slack-network-uncertain")
	}
	defer response.Body.Close()
	if response.StatusCode == 429 {
		duration := 60 * time.Second
		if seconds, e := time.ParseDuration(response.Header.Get("Retry-After") + "s"); e == nil && seconds > 0 {
			duration = seconds
		}
		h.rateMu.Lock()
		h.blockedUntil = time.Now().Add(duration)
		h.rateMu.Unlock()
		return nil, &apiFailure{"slack-throttled", 429}
	}
	if response.StatusCode != 200 {
		return nil, &apiFailure{"slack-http-failure", response.StatusCode}
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, (4<<20)+1))
	if err != nil || len(data) > 4<<20 {
		return nil, errors.New("slack-response-invalid")
	}
	var result map[string]json.RawMessage
	if json.Unmarshal(data, &result) != nil {
		return nil, errors.New("slack-response-invalid")
	}
	if string(result["ok"]) != "true" {
		switch str(result, "error") {
		case "invalid_auth", "not_authed", "token_revoked", "account_inactive", "session_expired":
			return nil, errors.New("slack-needs-link")
		case "channel_not_found", "not_in_channel", "is_archived", "restricted_action", "restricted_action_read_only_channel", "no_permission":
			return nil, &apiFailure{"slack-access-revoked", 400}
		case "invalid_arguments", "invalid_arg_name", "no_text", "msg_too_long", "invalid_thread_ts", "not_allowed_token_type", "missing_scope":
			return nil, &apiFailure{"slack-request-rejected", 400}
		default:
			return nil, errors.New("slack-provider-uncertain")
		}
	}
	return result, nil
}
func (h *helper) verify(ctx context.Context, s *session, expected string) error {
	result, err := h.call(ctx, s, "auth.test", map[string]any{})
	if err != nil {
		return err
	}
	owner := str(result, "user_id")
	if str(result, "team_id") != s.team || owner == "" || (expected != "" && owner != expected) {
		return errors.New("slack-identity-mismatch")
	}
	s.owner = owner
	s.label = str(result, "team")
	s.memberLabel = str(result, "user")
	s.verified = time.Now()
	return nil
}
func identity(s *session) map[string]any {
	return map[string]any{"team": s.team, "owner": s.owner, "label": s.label, "memberLabel": s.memberLabel}
}
func (h *helper) connect(ctx context.Context, team, owner string, interactive bool) (map[string]any, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	s := h.session
	if s != nil && s.team == team && (owner == "" || owner == s.owner) && time.Since(s.verified) < 15*time.Second {
		return identity(s), nil
	}
	if s == nil || s.team != team {
		var err error
		s, err = readSession(team, interactive)
		if err != nil {
			return nil, err
		}
	}
	if err := h.verify(ctx, s, owner); err != nil {
		if err.Error() != "slack-needs-link" {
			return nil, err
		}
		refreshed, e := readSession(team, false)
		if e != nil {
			h.session = nil
			return nil, e
		}
		if e = h.verify(ctx, refreshed, owner); e != nil {
			h.session = nil
			return nil, e
		}
		s = refreshed
	}
	h.session = s
	return identity(s), nil
}
func (h *helper) bound(id string, selectionCheck bool) (*session, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.session == nil {
		return nil, errors.New("slack-needs-link")
	}
	if id != "" && !selectionCheck && !h.selected[id] {
		return nil, errors.New("slack-scope-revoked")
	}
	return h.session, nil
}

type conversation struct {
	ID              string   `json:"id"`
	Name            string   `json:"name"`
	User            string   `json:"user"`
	IsIM            bool     `json:"is_im"`
	IsMPIM          bool     `json:"is_mpim"`
	IsMember        bool     `json:"is_member"`
	Archived        bool     `json:"is_archived"`
	External        bool     `json:"is_ext_shared"`
	PendingExternal bool     `json:"is_pending_ext_shared"`
	ReadOnly        bool     `json:"is_read_only"`
	Frozen          bool     `json:"is_frozen"`
	SharedTeamIDs   []string `json:"shared_team_ids"`
	Properties      struct {
		Posting struct {
			Type []string `json:"type"`
			User []string `json:"user"`
		} `json:"posting_restricted_to"`
	} `json:"properties"`
}

func (c conversation) normalized(s *session) map[string]any {
	kind := "channel"
	label := c.Name
	if c.IsIM {
		kind = "dm"
		if c.User == s.owner {
			kind = "self"
			label = "You (self DM)"
		} else if label == "" {
			label = "Direct message"
		}
	} else if c.IsMPIM {
		kind = "group"
	}
	supported := !c.Archived && !c.External && !c.PendingExternal && !c.ReadOnly && !c.Frozen && (c.IsIM || c.IsMPIM || c.IsMember)
	for _, team := range c.SharedTeamIDs {
		if team != s.team {
			supported = false
		}
	}
	if len(c.Properties.Posting.Type) > 0 || len(c.Properties.Posting.User) > 0 {
		supported = false
	}
	r := map[string]any{"id": c.ID, "label": label, "type": kind, "supported": supported}
	if !supported {
		r["reason"] = "slack-conversation-unsupported"
	}
	return r
}
func (h *helper) info(ctx context.Context, s *session, id string) (map[string]any, error) {
	result, err := h.call(ctx, s, "conversations.info", map[string]any{"channel": id, "include_num_members": false})
	if err != nil {
		return nil, err
	}
	var c conversation
	if json.Unmarshal(result["channel"], &c) != nil || c.ID != id {
		return nil, errors.New("slack-conversation-invalid")
	}
	return c.normalized(s), nil
}
func cursor(result map[string]json.RawMessage) string {
	var m struct {
		Next string `json:"next_cursor"`
	}
	_ = json.Unmarshal(result["response_metadata"], &m)
	return m.Next
}

type message struct {
	Conversation string `json:"conversation"`
	TS           string `json:"ts"`
	User         string `json:"user"`
	Text         string `json:"text"`
	ThreadTS     string `json:"thread_ts,omitempty"`
	Subtype      string `json:"subtype,omitempty"`
	BotID        string `json:"bot_id,omitempty"`
	AppID        string `json:"app_id,omitempty"`
	ClientID     string `json:"client_msg_id,omitempty"`
	ReplyCount   int    `json:"reply_count,omitempty"`
	LatestReply  string `json:"latest_reply,omitempty"`
}

func (h *helper) execute(ctx context.Context, op string, input map[string]json.RawMessage) (any, error) {
	switch op {
	case "discover":
		rows, err := discover()
		return map[string]any{"workspaces": rows}, err
	case "connect":
		return h.connect(ctx, str(input, "team"), str(input, "owner"), string(input["interactive"]) == "true")
	case "select":
		var ids []string
		if json.Unmarshal(input["conversations"], &ids) != nil || len(ids) > 500 {
			return nil, errors.New("slack-selection-limit")
		}
		h.mu.Lock()
		h.selected = map[string]bool{}
		h.observeUnselected = string(input["observeUnselected"]) == "true"
		for _, id := range ids {
			h.selected[id] = true
		}
		h.mu.Unlock()
		return map[string]any{}, nil
	case "unwatch":
		h.stopWatch()
		if string(input["clearSession"]) == "true" {
			h.mu.Lock()
			h.session = nil
			h.selected = map[string]bool{}
			h.observeUnselected = false
			h.mu.Unlock()
		}
		return map[string]any{}, nil
	case "watch":
		return map[string]any{}, h.watch()
	}
	id := str(input, "conversation")
	s, err := h.bound(id, op == "info" && string(input["selectionCheck"]) == "true")
	if err != nil {
		return nil, err
	}
	switch op {
	case "list":
		result, err := h.call(ctx, s, "users.conversations", map[string]any{"user": s.owner, "types": "public_channel,private_channel,im,mpim", "exclude_archived": true, "limit": 25, "cursor": str(input, "cursor")})
		if err != nil {
			return nil, err
		}
		var channels []conversation
		if json.Unmarshal(result["channels"], &channels) != nil {
			return nil, errors.New("slack-conversation-invalid")
		}
		rows := []any{}
		for _, c := range channels {
			// users.conversations guarantees owner membership but omits is_member.
			// Selection still independently checks conversations.info.
			c.IsMember = true
			row := c.normalized(s)
			if c.IsIM && c.User != "" && c.User != s.owner && string(input["labels"]) != "false" {
				user, e := h.call(ctx, s, "users.info", map[string]any{"user": c.User})
				if e == nil {
					var u struct {
						Name    string `json:"name"`
						Profile struct {
							Display string `json:"display_name"`
							Real    string `json:"real_name"`
						} `json:"profile"`
					}
					_ = json.Unmarshal(user["user"], &u)
					label := u.Profile.Display
					if label == "" {
						label = u.Profile.Real
					}
					if label == "" {
						label = u.Name
					}
					if label != "" {
						row["label"] = label
					}
				}
			}
			rows = append(rows, row)
		}
		return map[string]any{"conversations": rows, "nextCursor": cursor(result)}, nil
	case "info":
		return h.info(ctx, s, id)
	case "history", "replies":
		if id == "" {
			return nil, errors.New("slack-scope-revoked")
		}
		params := map[string]any{"channel": id, "limit": 100, "cursor": str(input, "cursor")}
		method := "conversations.history"
		if op == "replies" {
			thread := str(input, "thread")
			if !validTS.MatchString(thread) {
				return nil, errors.New("slack-scope-invalid")
			}
			params["ts"] = thread
			method = "conversations.replies"
		}
		if oldest := str(input, "oldest"); oldest != "" {
			params["oldest"] = oldest
			params["inclusive"] = true
		}
		result, err := h.call(ctx, s, method, params)
		if err != nil {
			return nil, err
		}
		var messages []message
		if json.Unmarshal(result["messages"], &messages) != nil {
			return nil, errors.New("slack-message-invalid")
		}
		for i := range messages {
			messages[i].Conversation = id
		}
		return map[string]any{"messages": messages, "nextCursor": cursor(result), "hasMore": string(result["has_more"]) == "true"}, nil
	case "send":
		text := str(input, "text")
		if id == "" || len([]rune(text)) > 4000 || text == "" {
			return map[string]any{"outcome": "failed", "retrySafe": false}, nil
		}
		info, err := h.info(ctx, s, id)
		if err != nil || info["supported"] != true {
			return map[string]any{"outcome": "failed", "retrySafe": false}, nil
		}
		params := map[string]any{"channel": id, "text": text, "client_msg_id": str(input, "clientMessageId"), "unfurl_links": false, "unfurl_media": false, "parse": "none", "link_names": false, "mrkdwn": false}
		if thread := str(input, "thread"); thread != "" {
			if !validTS.MatchString(thread) {
				return nil, errors.New("slack-scope-invalid")
			}
			params["thread_ts"] = thread
			params["reply_broadcast"] = false
		}
		result, err := h.call(ctx, s, "chat.postMessage", params)
		if err != nil {
			var failure *apiFailure
			if errors.As(err, &failure) && (failure.status == 400 || failure.status == 401 || failure.status == 403 || failure.status == 404 || failure.status == 405 || failure.status == 413 || failure.status == 415 || failure.status == 422 || failure.status == 429) {
				return map[string]any{"outcome": "failed", "retrySafe": true}, nil
			}
			if err.Error() == "slack-needs-link" {
				h.mu.Lock()
				h.session = nil
				h.mu.Unlock()
				return map[string]any{"outcome": "failed", "retrySafe": true}, nil
			}
			return map[string]any{"outcome": "ambiguous"}, nil
		}
		if str(result, "channel") != id || !validTS.MatchString(str(result, "ts")) {
			return map[string]any{"outcome": "ambiguous"}, nil
		}
		return map[string]any{"outcome": "confirmed", "ts": str(result, "ts")}, nil
	default:
		return nil, errors.New("slack-operation-rejected")
	}
}
func validSocket(raw string) bool {
	u, err := url.Parse(raw)
	return err == nil && u.Scheme == "wss" && u.User == nil && (u.Port() == "" || u.Port() == "443") && (u.Hostname() == "slack.com" || strings.HasSuffix(u.Hostname(), ".slack.com"))
}
func (h *helper) stopWatch() {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.watchCancel != nil {
		h.watchCancel()
		h.watchCancel = nil
	}
	if h.socket != nil {
		_ = h.socket.Close()
		h.socket = nil
	}
}

var powerOnce sync.Once
var powerError error

func (h *helper) watch() error {
	h.stopWatch()
	s, err := h.bound("", false)
	if err != nil {
		return err
	}
	powerOnce.Do(func() { powerError = startPower() })
	if powerError != nil {
		return powerError
	}
	ctx, cancel := context.WithCancel(context.Background())
	h.mu.Lock()
	h.watchCancel = cancel
	h.mu.Unlock()
	go h.socketLoop(ctx, s)
	go func() {
		count := wakeCount()
		ticker := time.NewTicker(250 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				next := wakeCount()
				if next != count {
					count = next
					event("wake", map[string]any{})
					h.mu.Lock()
					if h.socket != nil {
						_ = h.socket.Close()
					}
					h.mu.Unlock()
				}
			}
		}
	}()
	return nil
}
func (h *helper) socketLoop(ctx context.Context, s *session) {
	delay := time.Second
	for ctx.Err() == nil {
		result, err := h.call(ctx, s, "rtm.connect", map[string]any{"batch_presence_aware": true, "presence_sub": false})
		if err == nil {
			address := str(result, "url")
			if !validSocket(address) {
				health("needs_link", "slack-socket-origin")
				return
			}
			headers := http.Header{"Cookie": []string{"d=" + s.cookie}, "Origin": []string{"https://app.slack.com"}}
			socket, _, e := h.dial(ctx, address, headers)
			err = e
			if err == nil {
				h.mu.Lock()
				h.socket = socket
				h.mu.Unlock()
				socket.SetReadLimit(1 << 20)
				_ = socket.SetReadDeadline(time.Now().Add(45 * time.Second))
				socket.SetPongHandler(func(string) error { return socket.SetReadDeadline(time.Now().Add(45 * time.Second)) })
				health("connected", "")
				delay = time.Second
				done := make(chan struct{})
				go func() {
					ticker := time.NewTicker(15 * time.Second)
					defer ticker.Stop()
					for {
						select {
						case <-done:
							return
						case <-ctx.Done():
							return
						case <-ticker.C:
							if socket.WriteControl(websocket.PingMessage, nil, time.Now().Add(5*time.Second)) != nil {
								_ = socket.Close()
								return
							}
						}
					}
				}()
				for ctx.Err() == nil {
					_, data, e := socket.ReadMessage()
					if e != nil {
						err = e
						break
					}
					_ = socket.SetReadDeadline(time.Now().Add(45 * time.Second))
					var raw struct {
						Type    string `json:"type"`
						Channel string `json:"channel"`
						message
					}
					if json.Unmarshal(data, &raw) != nil {
						continue
					}
					if raw.Type == "goodbye" {
						break
					}
					if raw.Type != "message" {
						continue
					}
					h.mu.Lock()
					selected := h.selected[raw.Channel] || h.observeUnselected
					h.mu.Unlock()
					if !selected {
						continue
					}
					raw.message.Conversation = raw.Channel
					event("message", map[string]any{"message": raw.message})
				}
				close(done)
				_ = socket.Close()
			}
		}
		if ctx.Err() != nil {
			return
		}
		if err != nil && err.Error() == "slack-needs-link" {
			health("needs_link", "slack-session-revoked")
			return
		}
		health("reconnecting", "slack-socket-disconnected")
		select {
		case <-ctx.Done():
			return
		case <-time.After(delay):
		}
		if delay < 60*time.Second {
			delay *= 2
			if delay > 60*time.Second {
				delay = 60 * time.Second
			}
		}
	}
}
func main() {
	if len(os.Args) == 2 && os.Args[1] == "--licenses" {
		_ = fs.WalkDir(licenses, ".", func(name string, entry fs.DirEntry, err error) error {
			if err == nil && !entry.IsDir() {
				data, _ := licenses.ReadFile(name)
				fmt.Printf("%s\n%s\n", name, data)
			}
			return nil
		})
		return
	}
	if len(os.Args) == 2 && os.Args[1] == "--self-test" {
		emit(map[string]any{"version": "1", "protocol": protocol, "architecture": runtime.GOARCH})
		return
	}
	if len(os.Args) != 2 || os.Args[1] != "--rpc-v1" {
		os.Exit(2)
	}
	parent := os.Getppid()
	if parent == 1 {
		return
	}
	go func() {
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for range ticker.C {
			if os.Getppid() != parent {
				os.Exit(0)
			}
		}
	}()
	h := newHelper()
	defer h.stopWatch()
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 4096), 64<<10)
	for scanner.Scan() {
		var request struct {
			Version   int                        `json:"version"`
			ID        int                        `json:"id"`
			Operation string                     `json:"operation"`
			Input     map[string]json.RawMessage `json:"input"`
		}
		if json.Unmarshal(scanner.Bytes(), &request) != nil || request.Version != protocol || request.ID <= 0 {
			return
		}
		timeout := 25 * time.Second
		if request.Operation == "connect" && string(request.Input["interactive"]) == "true" {
			timeout = 55 * time.Second
		}
		ctx, cancel := context.WithTimeout(context.Background(), timeout)
		result, err := h.execute(ctx, request.Operation, request.Input)
		cancel()
		response := map[string]any{"version": protocol, "id": request.ID}
		if err != nil {
			response["error"] = safeError(err)
		} else {
			response["result"] = result
		}
		emit(response)
	}
}
