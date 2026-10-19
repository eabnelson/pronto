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
)

type roundTrip func(*http.Request) (*http.Response, error)

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
