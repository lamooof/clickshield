package httpapi

import (
	"context"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

func TestInviteRegistrationHTTP(t *testing.T) {
	env := newAPIEnv(t)
	ctx := context.Background()
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	create := func(ttl time.Duration) string {
		t.Helper()
		raw, _, err := env.st.CreateInvite(ctx, env.userID, ttl)
		if err != nil {
			t.Fatal(err)
		}
		return raw
	}
	request := func(method, token, origin string, form url.Values) (int, string) {
		t.Helper()
		var body string
		if form != nil {
			body = form.Encode()
		}
		r, _ := http.NewRequest(method, env.srv.URL+"/invite/"+token, strings.NewReader(body))
		if method == "POST" {
			r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
			r.Header.Set("Origin", origin)
		}
		res, err := client.Do(r)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		return res.StatusCode, res.Header.Get("Location")
	}
	token := create(time.Hour)
	if status, _ := request("GET", token, "", nil); status != 200 || !env.st.InviteValid(ctx, token) {
		t.Fatal("opening invite must not consume it")
	}
	email := "invite-" + token[:10] + "@example.test"
	t.Cleanup(func() { env.st.Pool.Exec(ctx, `DELETE FROM admin_users WHERE username=$1`, email) })
	form := url.Values{"email": {email}, "password": {"Invite-test-password-123"}, "password2": {"Invite-test-password-123"}}
	for _, origin := range []string{"null", "https://attacker.test"} {
		if status, _ := request("POST", token, origin, form); status != 403 || !env.st.InviteValid(ctx, token) {
			t.Fatalf("bad origin %q must be rejected without consuming invite", origin)
		}
	}
	if status, location := request("POST", token, env.srv.URL, form); status != 303 || location != "/" {
		t.Fatalf("registration = %d %s", status, location)
	}
	if env.st.InviteValid(ctx, token) {
		t.Fatal("accepted invite must be consumed")
	}
	if _, location := request("GET", token, "", nil); !strings.HasSuffix(location, "?error=invalid") {
		t.Fatal("used invite must be invalid")
	}
	duplicate := create(time.Hour)
	if _, location := request("POST", duplicate, env.srv.URL, form); !strings.HasSuffix(location, "?error=exists") || !env.st.InviteValid(ctx, duplicate) {
		t.Fatal("duplicate email must not consume new invite")
	}
	expired := create(-time.Minute)
	if _, location := request("GET", expired, "", nil); !strings.HasSuffix(location, "?error=invalid") {
		t.Fatal("expired invite must be invalid")
	}
}

func TestInviteBrowserRegistration(t *testing.T) {
	if os.Getenv("CLICKSHIELD_BROWSER_TESTS") != "1" {
		t.Skip("set CLICKSHIELD_BROWSER_TESTS=1 with Playwright Chromium/WebKit installed")
	}
	env := newAPIEnv(t)
	for _, engine := range []string{"chromium", "webkit"} {
		t.Run(engine, func(t *testing.T) {
			token, _, err := env.st.CreateInvite(context.Background(), env.userID, time.Hour)
			if err != nil {
				t.Fatal(err)
			}
			email := "browser-" + token[:10] + "@example.test"
			t.Cleanup(func() { env.st.Pool.Exec(context.Background(), `DELETE FROM admin_users WHERE username=$1`, email) })
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
			defer cancel()
			cmd := exec.CommandContext(ctx, "node", "../../scripts/invite-browser.mjs")
			// Bound output draining if a browser keeps the pipes open after Node exits.
			cmd.WaitDelay = 5 * time.Second
			cmd.Env = append(os.Environ(), "CLICKSHIELD_INVITE_BROWSER="+engine, "CLICKSHIELD_INVITE_BASE="+env.srv.URL, "CLICKSHIELD_INVITE_TOKEN="+token, "CLICKSHIELD_INVITE_EMAIL="+email)
			out, err := cmd.CombinedOutput()
			if err != nil {
				if ctx.Err() != nil {
					t.Fatalf("browser flow timed out: %v\n%s", ctx.Err(), out)
				}
				t.Fatalf("browser flow failed: %v\n%s", err, out)
			}
			t.Log(string(out))
		})
	}
}
