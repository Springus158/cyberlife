package state

import (
	"encoding/json"

	"github.com/kalor62/cyberlife/internal/logging"
)

// Getters hand their result to callers that read it outside the lock (Wails
// marshals bound return values on another goroutine, agents mutate copies
// before passing them back), so pointers into the live tree would race with
// the debounced save. Every pointer-returning getter returns a deep copy.
func clone[T any](src *T) *T {
	if src == nil {
		return nil
	}
	data, err := json.Marshal(src)
	if err != nil {
		logging.Error("state: clone marshal failed", "error", err)
		return nil
	}
	out := new(T)
	if err := json.Unmarshal(data, out); err != nil {
		logging.Error("state: clone unmarshal failed", "error", err)
		return nil
	}
	return out
}

func cloneSlice[T any](src []*T) []*T {
	out := make([]*T, 0, len(src))
	for _, item := range src {
		if c := clone(item); c != nil {
			out = append(out, c)
		}
	}
	return out
}
