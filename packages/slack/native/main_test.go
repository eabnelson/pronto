package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

type roundTrip func(*http.Request) (*http.Response, error)

func TestWorkspaceObservationDoesNotGrantReadOrSendAuthority(t *testing.T) {
	h := newHelper()
	h.session = &session{team: "TFIXTURE", owner: "UFIXTURE", token: "synthetic", cookie: "synthetic"}
	_, err := h.execute(context.Background(), "select", map[string]json.RawMessage{
		"conversations": json.RawMessage(`["CVERIFIED"]`), "observeUnselected": json.RawMessage(`true`),
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := h.bound("CUNKNOWN", false); err == nil {
		t.Fatal("observing a workspace granted unverified conversation access")
	}
	if _, err := h.bound("CVERIFIED", false); err != nil {
		t.Fatal(err)
	}
}

func (f roundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func TestSocketOrigins(t *testing.T) {
	for _, address := range []string{"wss://wss-primary.slack.com/path?secret=synthetic", "wss://slack.com/"} {
		if !validSocket(address) {
			t.Fatal("valid origin rejected")
		}
	}
	for _, address := range []string{"ws://wss-primary.slack.com/", "wss://slack.com.evil.invalid/", "wss://user@slack.com/", "wss://slack.com:444/", "https://slack.com/"} {
		if validSocket(address) {
			t.Fatal("unsafe origin accepted")
		}
	}
}
func TestSocketHandshakeUsesDesktopSessionAfterOriginValidation(t *testing.T) {
	for _, address := range []string{"wss://wss-primary.slack.com/fixture", "wss://slack.com.evil.invalid/fixture"} {
		t.Run(address, func(t *testing.T) {
			h := newHelper()
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			h.client = &http.Client{Transport: roundTrip(func(*http.Request) (*http.Response, error) {
				body := `{"ok":true,"url":"` + address + `"}`
				return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(body))}, nil
			})}
			calls := 0
			h.dial = func(_ context.Context, _ string, headers http.Header) (*websocket.Conn, *http.Response, error) {
				calls++
				cancel()
				if headers.Get("Cookie") != "d=synthetic-cookie" || headers.Get("Origin") != "https://app.slack.com" {
					t.Error("desktop session missing from WebSocket handshake")
				}
				return nil, nil, errors.New("fixture dial stopped")
			}
			h.socketLoop(ctx, &session{cookie: "synthetic-cookie"})
			if validSocket(address) && calls != 1 || !validSocket(address) && calls != 0 {
				t.Fatal("socket origin was not checked before sending session headers")
			}
		})
	}
}
func TestUnsupportedDestinations(t *testing.T) {
	s := &session{team: "TFIXTURE", owner: "UFIXTURE"}
	for _, c := range []conversation{{ID: "C1", IsMember: true, External: true}, {ID: "C1", IsMember: true, ReadOnly: true}, {ID: "C1", IsMember: true, Archived: true}, {ID: "C1", IsMember: true, SharedTeamIDs: []string{"TOTHER"}}, {ID: "C1"}} {
		if c.normalized(s)["supported"] == true {
			t.Fatal("unsupported target accepted")
		}
	}
	if (conversation{ID: "D1", IsIM: true, User: "UFIXTURE"}).normalized(s)["type"] != "self" {
		t.Fatal("self DM missing")
	}
}
func TestPickerFindsOwnerSelfDMWithoutScanningUnjoinedWorkspaceChannels(t *testing.T) {
	h := newHelper()
	h.session = &session{team: "TFIXTURE", owner: "UFIXTURE", token: "synthetic", cookie: "synthetic"}
	h.client = &http.Client{Transport: roundTrip(func(req *http.Request) (*http.Response, error) {
		body := `{"ok":true,"channels":[{"id":"CUNJOINED","name":"unjoined"}],"response_metadata":{"next_cursor":"more-workspace-channels"}}`
		if req.URL.Path == "/api/users.conversations" {
			query := req.URL.Query()
			if query.Get("user") != "UFIXTURE" || query.Get("cursor") != "owner-first" || query.Get("types") != "public_channel,private_channel,im,mpim" {
				t.Fatal("picker did not bind pagination to the verified owner")
			}
			// This endpoint guarantees membership but omits is_member.
			body = `{"ok":true,"channels":[{"id":"DSELF","is_im":true,"user":"UFIXTURE"},{"id":"CJOINED","name":"joined"}],"response_metadata":{"next_cursor":"owner-next"}}`
		}
		return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(body))}, nil
	})}
	result, err := h.execute(context.Background(), "list", map[string]json.RawMessage{"cursor": json.RawMessage(`"owner-first"`), "user": json.RawMessage(`"UOTHER"`)})
	if err != nil {
		t.Fatal(err)
	}
	page := result.(map[string]any)
	rows := page["conversations"].([]any)
	if len(rows) != 2 || rows[0].(map[string]any)["type"] != "self" || rows[0].(map[string]any)["supported"] != true {
		t.Fatal("owner self DM hidden behind unrelated workspace channels")
	}
	if rows[1].(map[string]any)["supported"] != true || page["nextCursor"] != "owner-next" {
		t.Fatal("owner membership or pagination was lost")
	}
}
func TestSendNeverRetriesUncertainWrites(t *testing.T) {
	for _, status := range []int{200, 400, 408, 429, 500, 503, 0, -1} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			h := newHelper()
			h.session = &session{team: "TFIXTURE", owner: "UFIXTURE", token: "synthetic", cookie: "synthetic"}
			h.selected["DFIXTURE"] = true
			posts := 0
			h.client = &http.Client{Transport: roundTrip(func(req *http.Request) (*http.Response, error) {
				h.lastCall = time.Time{}
				body := `{"ok":true,"channel":{"id":"DFIXTURE","is_im":true,"user":"UFIXTURE"}}`
				code := 200
				if req.Method == "POST" {
					posts++
					code = status
					body = `{"ok":true,"channel":"DFIXTURE","ts":"1792152000.000001"}`
					if status == -1 {
						code = 200
						body = `{"ok":false,"error":"internal_error"}`
					}
					if status == 0 {
						return nil, errors.New("synthetic network loss")
					}
				}
				return &http.Response{StatusCode: code, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(body))}, nil
			})}
			input := map[string]json.RawMessage{"conversation": json.RawMessage(`"DFIXTURE"`), "text": json.RawMessage(`"Synthetic reply"`), "clientMessageId": json.RawMessage(`"synthetic-nonce"`)}
			result, err := h.execute(context.Background(), "send", input)
			if err != nil {
				t.Fatal(err)
			}
			outcome := result.(map[string]any)["outcome"]
			expected := "ambiguous"
			if status == 200 {
				expected = "confirmed"
			} else if status == 400 || status == 429 {
				expected = "failed"
			}
			if outcome != expected || posts != 1 {
				t.Fatalf("outcome %v / posts %d", outcome, posts)
			}
		})
	}
}

func TestFocusedSearchIsBoundedAndOwnerBound(t *testing.T) {
	h := newHelper()
	h.session = &session{team: "TTEST", owner: "UOWNER", token: "synthetic", cookie: "synthetic"}
	h.selected["CTEST"] = true
	calls := 0
	h.client = &http.Client{Transport: roundTrip(func(req *http.Request) (*http.Response, error) {
		calls++
		h.lastCall = time.Time{}
		q := req.URL.Query()
		if req.URL.Path != "/api/search.messages" || q.Get("sort") != "timestamp" || q.Get("sort_dir") != "desc" {
			t.Fatal("unexpected search")
		}
		if calls == 1 && (q.Get("query") != `"@test" after:2026-10-15` || q.Get("count") != "100" || q.Get("page") != "1") {
			t.Fatalf("unbounded tag search: %v", q)
		}
		if calls == 2 && (q.Get("query") != "from:<@UOWNER> in:CTEST" || q.Get("count") != "3") {
			t.Fatalf("owner search lost binding: %v", q)
		}
		body := `{"ok":true,"messages":{"matches":[{"channel":{"id":"CTEST"},"team":"TTEST","user":"UOWNER","ts":"1792152000.000001","text":"@test synthetic","permalink":"https://synthetic.slack.com/archives/CTEST/p1792152000000001?thread_ts=1700000000.000001"},{"channel":{"id":"COTHER"},"team":"TOTHER","user":"UOWNER","ts":"1792152000.000002","text":"wrong workspace"}],"paging":{"pages":2}}}`
		return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(body))}, nil
	})}
	result, err := h.execute(context.Background(), "tagged", map[string]json.RawMessage{"tag": json.RawMessage(`"@test"`), "oldest": json.RawMessage(`"1792152000"`)})
	if err != nil {
		t.Fatal(err)
	}
	page := result.(map[string]any)
	messages := page["messages"].([]message)
	if len(messages) != 1 || messages[0].ThreadTS != "1700000000.000001" || page["nextCursor"] != "2" {
		t.Fatalf("lost thread identity or pagination: %v", page)
	}
	if _, err = h.execute(context.Background(), "participation", map[string]json.RawMessage{"conversation": json.RawMessage(`"CTEST"`), "owner": json.RawMessage(`"UATTACKER"`)}); err != nil {
		t.Fatal(err)
	}
	for _, input := range []map[string]json.RawMessage{
		{"tag": json.RawMessage(`"@test OR password"`), "oldest": json.RawMessage(`"1792152000"`)},
		{"tag": json.RawMessage(`"@test"`), "oldest": json.RawMessage(`"1792152000"`), "cursor": json.RawMessage(`"6"`)},
	} {
		if _, err = h.execute(context.Background(), "tagged", input); err == nil {
			t.Fatal("unbounded query accepted")
		}
	}
	if calls != 2 {
		t.Fatal("invalid search reached network")
	}
	if _, err = h.execute(context.Background(), "participation", map[string]json.RawMessage{"conversation": json.RawMessage(`"CUNKNOWN"`)}); err == nil {
		t.Fatal("unverified conversation granted search access")
	}
}

func TestCanonicalLookupPinsBothTimestampBounds(t *testing.T) {
	h := newHelper()
	h.session = &session{team: "TTEST", owner: "UOWNER"}
	h.selected["CTEST"] = true
	h.client = &http.Client{Transport: roundTrip(func(req *http.Request) (*http.Response, error) {
		q := req.URL.Query()
		if q.Get("oldest") != "1792152000.000001" || q.Get("latest") != "1792152000.000001" || q.Get("inclusive") != "true" || q.Get("limit") != "1" {
			t.Fatalf("lookup became a timeline scan: %v", q)
		}
		return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(`{"ok":true,"messages":[]}`))}, nil
	})}
	_, err := h.execute(context.Background(), "history", map[string]json.RawMessage{"conversation": json.RawMessage(`"CTEST"`), "oldest": json.RawMessage(`"1792152000.000001"`), "latest": json.RawMessage(`"1792152000.000001"`), "limit": json.RawMessage(`1`)})
	if err != nil {
		t.Fatal(err)
	}
}
