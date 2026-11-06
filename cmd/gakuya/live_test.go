package main

import "testing"

func TestCheckLiveURL(t *testing.T) {
	for raw, want := range map[string]string{
		"http://127.0.0.1:8917":  "http://127.0.0.1:8917",
		"http://127.0.0.1:8917/": "http://127.0.0.1:8917",
		"http://localhost:8917":  "http://127.0.0.1:8917",
		"http://[::1]:8917":      "http://[::1]:8917",
	} {
		got, err := checkLiveURL(raw)
		if err != nil || got.String() != want {
			t.Errorf("%s: got %v, %v; want %s", raw, got, err, want)
		}
	}
	for _, raw := range []string{
		"", "127.0.0.1:8917", "http://example.com:8917", "http://10.0.0.1:8917", "http://127.0.0.2:8917",
		"https://127.0.0.1:8917", "http://127.0.0.1", "http://127.0.0.1:99999", "http://127.0.0.1:0",
		"http://user@127.0.0.1:8917", "http://127.0.0.1:8917/x", "http://127.0.0.1:8917?a=1",
	} {
		if got, err := checkLiveURL(raw); err == nil {
			t.Errorf("%s: should be refused, got %v", raw, got)
		}
	}
}
