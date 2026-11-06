package antifraud

import (
	"context"
	"strings"
	"time"

	"github.com/lamooof/clickshield/internal/bots"
	"github.com/lamooof/clickshield/internal/domain"
	"github.com/lamooof/clickshield/internal/traffic"
)

type IngestResult struct {
	InsertedEvents int    `json:"inserted_events"`
	Decision       string `json:"decision"`
}

type PreparedEvent struct {
	Index     int          `json:"index"`
	At        time.Time    `json:"at"`
	PageIndex int          `json:"page_index"`
	PageURL   string       `json:"page_url"`
	Event     domain.Event `json:"event"`
}

type PreparedBatch struct {
	Project              domain.Project
	Batch                domain.EventBatch
	Remote               domain.RemoteMeta
	BotName, BotCategory string
	Browser, OS          string
	Attribution          traffic.Attribution
	BlockedClasses       []string
	Active               bool
	Events               []PreparedEvent
}

type BatchRepository interface {
	WriteBatch(context.Context, PreparedBatch) (int, bool, error)
}

type Ingestor struct{ repository BatchRepository }

func NewIngestor(repository BatchRepository) *Ingestor { return &Ingestor{repository} }

func (s *Ingestor) Ingest(ctx context.Context, p domain.Project, b domain.EventBatch, remote domain.RemoteMeta) (IngestResult, error) {
	prepared := PrepareBatch(p, b, remote, time.Now().UTC())
	inserted, blocked, err := s.repository.WriteBatch(ctx, prepared)
	decision := "MONITOR"
	if len(prepared.BlockedClasses) > 0 {
		decision = "ALLOW"
		if blocked {
			decision = "BLOCK"
		}
	}
	return IngestResult{inserted, decision}, err
}

func PrepareBatch(p domain.Project, b domain.EventBatch, remote domain.RemoteMeta, now time.Time) PreparedBatch {
	if b.PageIndex < 1 {
		b.PageIndex = 1
	}
	switch strings.ToLower(b.Device.Type) {
	case "desktop", "mobile", "tablet":
		b.Device.Type = strings.ToLower(b.Device.Type)
	default:
		b.Device.Type = "unknown"
	}
	if b.Automation == nil {
		b.Automation = map[string]bool{}
	}
	bot, _ := bots.Identify(remote.UserAgent, remote.IP.String())
	prepared := PreparedBatch{Project: p, Batch: b, Remote: remote, BotName: bot.Name, BotCategory: bot.Category, Attribution: traffic.Classify(b, p.AllowedOrigins)}
	prepared.Browser, prepared.OS = ParseUserAgent(remote.UserAgent)
	switch p.Mode {
	case domain.ModeBlocking:
		prepared.BlockedClasses = []string{domain.Bot, domain.KnownBot}
	case domain.ModeBlockingBots:
		prepared.BlockedClasses = []string{domain.Bot}
	}
	for i, event := range b.Events {
		if event.Type != "heartbeat" && event.Type != "visibility" && event.Type != "automation" || event.ActiveMS > 0 || (event.Type == "visibility" && event.Visible != nil && *event.Visible) {
			prepared.Active = true
		}
		at := time.UnixMilli(event.TS).UTC()
		if event.TS <= 0 || at.Before(now.Add(-7*24*time.Hour)) || at.After(now.Add(10*time.Minute)) {
			at = now
			event.TS = now.UnixMilli()
		}
		index := event.PageIndex
		if index < 1 {
			index = b.PageIndex
		}
		prepared.Events = append(prepared.Events, PreparedEvent{Index: i, At: at, PageIndex: index, Event: event})
	}
	return prepared
}

// ResolvePages accounts for pageviews in this batch as well as prior SPA pages.
func ResolvePages(b *PreparedBatch, pages map[int]string) {
	for _, e := range b.Events {
		if e.Event.Type == "pageview" {
			page, _ := e.Event.Extra["page_url"].(string)
			if page == "" {
				page = b.Batch.PageURL
			}
			if pages[e.PageIndex] == "" {
				pages[e.PageIndex] = page
			}
		}
	}
	for i, e := range b.Events {
		page := pages[e.PageIndex]
		if page == "" {
			page = b.Batch.PageURL
		}
		if e.Event.PageURL != "" {
			page = e.Event.PageURL
		}
		if e.Event.Type == "pageview" {
			if explicit, _ := e.Event.Extra["page_url"].(string); explicit != "" {
				page = explicit
			}
		}
		if e.Event.Type != "pageview" {
			page = strings.SplitN(page, "?", 2)[0]
		}
		b.Events[i].PageURL = page
	}
}
