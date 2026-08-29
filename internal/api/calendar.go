// Google Calendar endpoints for addons. Two things bound them: the addon host
// refuses cl.api() calls from a manifest without the "calendar" permission,
// and only calendars the user ticked as shared in Settings → Google Calendar
// resolve here — anything else answers 404, so a token that can read a whole
// account still cannot be used to browse it from an addon.
package api

import (
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/kalor62/cyberlife/internal/calendar"
)

// CalendarHooks are the App-side operations the server cannot do itself
type CalendarHooks struct {
	Accounts func() any
	List     func(calendarID, from, to string) (any, error)
	Create   func(calendarID string, in calendar.EventInput) (any, error)
	Update   func(calendarID, eventID string, in calendar.EventInput) (any, error)
	Delete   func(calendarID, eventID string) error
}

type calendarEventRequest struct {
	Calendar string `json:"calendar"`
	Event    string `json:"event,omitempty"`
	// Op lets a POST stand in for PATCH/DELETE: the addon SDK's api() can only
	// issue GET and POST, so without it addons could create events but never
	// change or remove them.
	Op    string `json:"op,omitempty"`
	Title string `json:"title,omitempty"`
	Date  string `json:"date,omitempty"`
	Start string `json:"start,omitempty"`
	End   string `json:"end,omitempty"`
	Note  string `json:"note,omitempty"`
}

func (r calendarEventRequest) input() calendar.EventInput {
	return calendar.EventInput{
		Title: r.Title, Date: r.Date, Start: r.Start, End: r.End, Note: r.Note,
	}
}

// writeCalendarErr maps a missing calendar or event to 404 and everything else
// to 400, so callers can tell "wrong id" from "bad request".
func writeCalendarErr(w http.ResponseWriter, err error) {
	var nf *calendar.NotFoundError
	if errors.As(err, &nf) {
		writeErr(w, http.StatusNotFound, err)
		return
	}
	writeErr(w, http.StatusBadRequest, err)
}

func (s *Server) handleCalendarAccounts(w http.ResponseWriter, r *http.Request) {
	if s.calendar.Accounts == nil {
		writeErr(w, http.StatusServiceUnavailable, fmt.Errorf("calendar integration unavailable"))
		return
	}
	writeJSON(w, http.StatusOK, s.calendar.Accounts())
}

// handleCalendarEvents is the whole event CRUD: GET lists a window, POST
// creates, PATCH updates, DELETE removes.
func (s *Server) handleCalendarEvents(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		s.calendarList(w, r)
	case http.MethodPost:
		s.calendarPost(w, r)
	case http.MethodPatch, http.MethodPut:
		s.calendarWrite(w, r, "update")
	case http.MethodDelete:
		s.calendarWrite(w, r, "delete")
	default:
		writeErr(w, http.StatusMethodNotAllowed, fmt.Errorf("GET, POST, PATCH or DELETE"))
	}
}

func (s *Server) calendarList(w http.ResponseWriter, r *http.Request) {
	if s.calendar.List == nil {
		writeErr(w, http.StatusServiceUnavailable, fmt.Errorf("calendar integration unavailable"))
		return
	}
	q := r.URL.Query()
	calendarID := strings.TrimSpace(q.Get("calendar"))
	if calendarID == "" {
		writeErr(w, http.StatusBadRequest, fmt.Errorf("calendar is required"))
		return
	}
	// A month around today is the window the calendar views ask for anyway
	from := q.Get("from")
	to := q.Get("to")
	if from == "" {
		from = time.Now().AddDate(0, 0, -7).Format("2006-01-02")
	}
	if to == "" {
		to = time.Now().AddDate(0, 1, 0).Format("2006-01-02")
	}
	out, err := s.calendar.List(calendarID, from, to)
	if err != nil {
		writeCalendarErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// calendarPost dispatches on the body's "op" so POST covers all three writes
func (s *Server) calendarPost(w http.ResponseWriter, r *http.Request) {
	var probe calendarEventRequest
	if !decodeBody(w, r, &probe) {
		return
	}
	op := strings.ToLower(strings.TrimSpace(probe.Op))
	switch op {
	case "", "create", "update", "delete":
	default:
		writeErr(w, http.StatusBadRequest, fmt.Errorf("unknown op %q (create, update or delete)", probe.Op))
		return
	}
	if op == "" {
		op = "create"
	}
	s.calendarWriteReq(w, probe, op)
}

func (s *Server) calendarWrite(w http.ResponseWriter, r *http.Request, op string) {
	var req calendarEventRequest
	if !decodeBody(w, r, &req) {
		return
	}
	s.calendarWriteReq(w, req, op)
}

func (s *Server) calendarWriteReq(w http.ResponseWriter, req calendarEventRequest, op string) {
	if strings.TrimSpace(req.Calendar) == "" {
		writeErr(w, http.StatusBadRequest, fmt.Errorf("calendar is required"))
		return
	}
	switch op {
	case "create":
		if s.calendar.Create == nil {
			writeErr(w, http.StatusServiceUnavailable, fmt.Errorf("calendar integration unavailable"))
			return
		}
		out, err := s.calendar.Create(req.Calendar, req.input())
		if err != nil {
			writeCalendarErr(w, err)
			return
		}
		writeJSON(w, http.StatusOK, out)
	case "update":
		if s.calendar.Update == nil {
			writeErr(w, http.StatusServiceUnavailable, fmt.Errorf("calendar integration unavailable"))
			return
		}
		out, err := s.calendar.Update(req.Calendar, req.Event, req.input())
		if err != nil {
			writeCalendarErr(w, err)
			return
		}
		writeJSON(w, http.StatusOK, out)
	case "delete":
		if s.calendar.Delete == nil {
			writeErr(w, http.StatusServiceUnavailable, fmt.Errorf("calendar integration unavailable"))
			return
		}
		if err := s.calendar.Delete(req.Calendar, req.Event); err != nil {
			writeCalendarErr(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	}
}
