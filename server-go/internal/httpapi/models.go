package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"

	"github.com/NoobBandi/TenkStack/server-go/internal/api"
	"github.com/NoobBandi/TenkStack/server-go/internal/gguf"
	"github.com/NoobBandi/TenkStack/server-go/internal/llamaswap"
	"github.com/NoobBandi/TenkStack/server-go/internal/providers"
	"github.com/NoobBandi/TenkStack/server-go/internal/vendors"
)

// readModels is the configured models joined with which are resident.
// Running models say what they actually loaded; stopped ones fall back to
// what their command line declares.
func (s *Server) readModels(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	var models, running []map[string]any
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); models = s.LlamaSwap.ListModels(ctx) }()
	go func() { defer wg.Done(); running = s.LlamaSwap.Running(ctx) }()
	wg.Wait()

	byID := map[string]map[string]any{}
	for _, entry := range running {
		if id, _ := entry["model"].(string); id != "" {
			byID[id] = entry
		}
	}
	props := map[string]map[string]any{}
	slots := map[string][]api.Slot{}
	var mu sync.Mutex
	providerOf := s.Models.ProviderKeys()
	for id, entry := range byID {
		proxy, _ := entry["proxy"].(string)
		// /props and /slots are llama-server's; another provider answers
		// 404 twice a poll, which is noise in its log for nothing.
		if proxy == "" || formOf(providerOf[id]) != providers.FormLlama {
			continue
		}
		wg.Add(1)
		go func(id, proxy string) {
			defer wg.Done()
			p := s.LlamaSwap.Props(ctx, proxy)
			sl := s.LlamaSwap.Slots(ctx, proxy)
			mu.Lock()
			props[id] = p
			slots[id] = sl
			mu.Unlock()
		}(id, proxy)
	}
	wg.Wait()

	contexts := s.Models.ContextSizes()
	declared := s.Models.DeclaredVision()
	chatParams := s.Models.ChatParams()
	sampling := s.Models.SamplingDefaults()
	weights := s.Models.Weights()

	out := make([]map[string]any, 0, len(models))
	for _, m := range models {
		id, _ := m["id"].(string)
		row := map[string]any{}
		for k, v := range m {
			row[k] = v
		}
		entry := byID[id]
		live := props[id]
		modalities, _ := live["modalities"].(map[string]any)
		row["running"] = entry != nil
		row["state"] = "stopped"
		row["proxy"] = nil
		row["ttl"] = nil
		if entry != nil {
			if st, ok := entry["state"]; ok {
				row["state"] = st
			}
			row["proxy"] = entry["proxy"]
			row["ttl"] = entry["ttl"]
		}
		row["ctx_size"] = nil
		if c, ok := contexts[id]; ok {
			row["ctx_size"] = c
		}
		row["sampling"] = nil
		if sm := sampling[id]; len(sm) > 0 {
			row["sampling"] = sm
		}
		row["weights"] = []api.Weight{}
		if wl, ok := weights[id]; ok {
			row["weights"] = wl
		}
		row["slots"] = nil
		if sl, ok := slots[id]; ok && sl != nil {
			row["slots"] = sl
		}
		caps := api.Capabilities{Source: "config", Vision: declared[id], Params: chatParams[id]}
		// A server engine has no /props to ask. Tool calling is a launch
		// flag its record's recommended flags write, so the record says.
		if p := providers.Get(providerOf[id]); p != nil && p.Tools {
			caps.Tools = true
		}
		if live != nil {
			caps.Source = "live"
			caps.Vision, _ = modalities["vision"].(bool)
			caps.Audio, _ = modalities["audio"].(bool)
			tpl, _ := live["chat_template"].(string)
			caps.Tools = tpl != ""
		}
		row["capabilities"] = caps
		// Which inference engine starts the entry, so the list can be
		// grouped by it; an entry named by hand is llama.cpp.
		key := providerOf[id]
		if key == "" {
			key = providers.DefaultProvider().Key
		}
		row["provider"] = key
		if p := providers.Get(key); p != nil {
			row["provider_name"] = p.Name
		}
		out = append(out, row)
	}
	writeJSON(w, http.StatusOK, out)
}

// deviceEnv resolves one or more backend:index choices against what
// llama-server enumerates. Empty map means no card asked for; nil means a
// card was asked for and could not be resolved, which must leave the
// stored selector alone.
func (s *Server) deviceEnv(r *http.Request, chosen []string) map[string]string {
	if len(chosen) == 0 {
		return map[string]string{}
	}
	devices := s.Backends.Usable(r.Context(), false)
	byBackend := map[string][]string{}
	var order []string
	for _, item := range chosen {
		backend, index, _ := strings.Cut(item, ":")
		hit := false
		for _, d := range devices {
			if d.Backend == backend && itoa(d.Index) == index {
				hit = true
			}
		}
		if !hit {
			return nil
		}
		if _, seen := byBackend[backend]; !seen {
			order = append(order, backend)
		}
		byBackend[backend] = append(byBackend[backend], index)
	}
	if len(order) != 1 {
		// One llama-server process, one backend.
		return nil
	}
	sel, ok := vendors.BackendSelectors()[strings.ToUpper(order[0])]
	if !ok {
		return nil
	}
	return map[string]string{sel.Variable: strings.ReplaceAll(sel.Template, "{}", strings.Join(byBackend[order[0]], ","))}
}

// deviceWrapper is the launcher macro for the chosen cards, or "" to leave
// the entry's launcher alone.
func (s *Server) deviceWrapper(r *http.Request, chosen []string) string {
	if len(chosen) == 0 {
		return ""
	}
	backend, index, _ := strings.Cut(chosen[0], ":")
	for _, d := range s.Backends.Usable(r.Context(), false) {
		if d.Backend == backend && itoa(d.Index) == index {
			return s.Config.WrapperFor(d.Launcher)
		}
	}
	return ""
}

func itoa(n int) string { return strconv.Itoa(n) }

func chosenDevices(v any) (list []string, present bool) {
	switch x := v.(type) {
	case nil:
		return nil, false
	case string:
		if x != "" {
			list = []string{x}
		}
		return list, true
	case []any:
		for _, item := range x {
			if s, _ := item.(string); s != "" {
				list = append(list, s)
			}
		}
		return list, true
	}
	return nil, true
}

func (s *Server) createModel(w http.ResponseWriter, r *http.Request) {
	if !s.owner(w, r) {
		return
	}
	var raw map[string]json.RawMessage
	if err := readJSON(r, &raw); err != nil {
		fail(w, http.StatusUnprocessableEntity, "invalid JSON body")
		return
	}
	spec := api.ModelSpec{CtxSize: 16384, NGpuLayers: 99, TTL: 900, Group: strp("large")}
	if _, has := raw["model_file"]; !has {
		fail(w, http.StatusUnprocessableEntity, "model_file is required")
		return
	}
	body, _ := json.Marshal(raw)
	if err := json.Unmarshal(body, &spec); err != nil || spec.ID == "" {
		fail(w, http.StatusUnprocessableEntity, "id is required")
		return
	}
	chosen, present := chosenDevices(spec.Device)
	env := s.deviceEnv(r, chosen)
	var managed map[string]bool
	if present && env != nil {
		managed = vendors.SelectorVariables()
	}
	if env == nil {
		env = map[string]string{}
	}
	// A named runtime wins over the launcher the card implies: the card
	// says which llama.cpp build sees it, and the entry may not be one.
	wrapper := s.deviceWrapper(r, chosen)
	if spec.Runtime != "" {
		if _, ok := s.Config.LauncherMacros()[spec.Runtime]; !ok {
			fail(w, http.StatusBadRequest, "沒有叫 "+spec.Runtime+" 的執行環境，或它已停用")
			return
		}
		wrapper = "${" + spec.Runtime + "}"
	}
	err := s.Config.Upsert(r.Context(), spec, env, managed, wrapper)
	if err != nil {
		if errors.Is(err, llamaswap.Rejected) {
			fail(w, http.StatusBadRequest, err.Error())
			return
		}
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, api.ModelWritten{OK: true, ID: spec.ID})
}

func strp(s string) *string { return &s }

func (s *Server) readModelSpec(w http.ResponseWriter, r *http.Request) {
	spec := s.Models.ReadSpec(r.PathValue("id"))
	if spec == nil {
		fail(w, http.StatusNotFound, "no such model")
		return
	}
	writeJSON(w, http.StatusOK, spec)
}

func (s *Server) unloadOne(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, api.OK{OK: s.LlamaSwap.UnloadModel(r.Context(), r.PathValue("id"))})
}

func (s *Server) unloadAll(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, api.OK{OK: s.LlamaSwap.UnloadAll(r.Context())})
}

func (s *Server) modelFiles(w http.ResponseWriter, r *http.Request) {
	files, _ := s.Models.FilesForModel(r.PathValue("id"))
	if files == nil {
		files = []api.ModelFile{}
	}
	writeJSON(w, http.StatusOK, files)
}

func (s *Server) removeModel(w http.ResponseWriter, r *http.Request) {
	if !s.owner(w, r) {
		return
	}
	q := r.URL.Query().Get("delete_files")
	result, err := s.Models.Delete(r.Context(), r.PathValue("id"), q == "true" || q == "1")
	if err != nil {
		if errors.Is(err, llamaswap.Rejected) {
			fail(w, http.StatusBadRequest, err.Error())
			return
		}
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	if result == nil {
		fail(w, http.StatusNotFound, "no such model")
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) readPartials(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, s.Models.ListPartials())
}

func refused(w http.ResponseWriter, err error) bool {
	var r *llamaswap.Refused
	if errors.As(err, &r) {
		fail(w, http.StatusConflict, r.Reason)
		return true
	}
	if err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return true
	}
	return false
}

func (s *Server) removePartial(w http.ResponseWriter, r *http.Request) {
	if !s.owner(w, r) {
		return
	}
	result, err := s.Models.DeletePartial(r.PathValue("filename"))
	if refused(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) removeFile(w http.ResponseWriter, r *http.Request) {
	if !s.owner(w, r) {
		return
	}
	result, err := s.Models.DeleteFile(r.PathValue("filename"))
	if refused(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) readModelFiles(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, s.Models.ListWeights())
}

// readRecommended is what one GGUF says its publisher recommends, read on
// demand since the form asks for one file at a time.
func (s *Server) readRecommended(w http.ResponseWriter, r *http.Request) {
	target, _, ok := s.Models.Place(r.URL.Query().Get("file"))
	if !ok {
		fail(w, http.StatusBadRequest, "路徑不在模型目錄裡")
		return
	}
	if st, err := os.Stat(target); err != nil || !st.Mode().IsRegular() {
		fail(w, http.StatusNotFound, "找不到這個檔案")
		return
	}
	writeJSON(w, http.StatusOK, api.Recommended{Sampling: gguf.Sampling(target)})
}
