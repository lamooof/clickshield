package httpapi

import (
	"bytes"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestInviteReferrerPolicy(t *testing.T) {
	page, err := assets.ReadFile("assets/invite.html")
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{}
	res := httptest.NewRecorder()
	s.security(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write(page) })).ServeHTTP(res, httptest.NewRequest("GET", "https://clickshield.test/invite/test-token", nil))
	if got := res.Header().Get("Referrer-Policy"); got != "strict-origin" {
		t.Fatalf("invite policy = %q, want strict-origin", got)
	}
	if !strings.Contains(res.Body.String(), `<meta name="referrer" content="strict-origin">`) {
		t.Fatal("invite HTML must use the same strict-origin policy")
	}
}

func TestFormOriginValidation(t *testing.T) {
	for _, tc := range []struct {
		origin  string
		allowed bool
	}{{"https://clickshield.test", true}, {"null", false}, {"https://attacker.test", false}} {
		t.Run(tc.origin, func(t *testing.T) {
			r := httptest.NewRequest("POST", "https://clickshield.test/invite/test-token", nil)
			r.Header.Set("Origin", tc.origin)
			if got := sameOrigin(r); got != tc.allowed {
				t.Fatalf("sameOrigin = %t, want %t", got, tc.allowed)
			}
		})
	}
}

func TestInviteTokenIsNotLogged(t *testing.T) {
	var logs bytes.Buffer
	s := &Server{log: slog.New(slog.NewJSONHandler(&logs, nil))}
	handler := s.logRequests(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) }))
	for _, method := range []string{"GET", "POST"} {
		handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(method, "/invite/secret-token?error=invalid", nil))
	}
	if strings.Contains(logs.String(), "secret-token") || !strings.Contains(logs.String(), "/invite/[REDACTED]") {
		t.Fatal(logs.String())
	}
}

func TestTrackerIncludesRuntimeModules(t *testing.T) {
	res := httptest.NewRecorder()
	(&Server{}).tracker(res, httptest.NewRequest("GET", "/tracker.js", nil))
	for _, part := range []string{"function trackerTransport", "function trackerSession", "window.ClickShield ="} {
		if !strings.Contains(res.Body.String(), part) {
			t.Fatalf("missing tracker component %s", part)
		}
	}
}
