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
