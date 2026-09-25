package httpapi

import (
	"bytes"
	gocontext "context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/NoobBandi/TenkStack/server-go/internal/api"
	"github.com/NoobBandi/TenkStack/server-go/internal/backends"
	"github.com/NoobBandi/TenkStack/server-go/internal/comfy"
	"github.com/NoobBandi/TenkStack/server-go/internal/containers"
	"github.com/NoobBandi/TenkStack/server-go/internal/providers"
	"github.com/NoobBandi/TenkStack/server-go/internal/vendors"
)

// comfyPort checks a port against the discovery range rather than trusting
// it: these routes fetch on the caller's behalf, and an unchecked port would
// make the console a relay to everything listening on this machine.
func (s *Server) comfyPort(w http.ResponseWriter, r *http.Request) (int, bool) {
	port, ok := queryInt(w, r, "port", s.Ports.ComfyFirst)
	if !ok {
		return 0, false
	}
	if !s.ComfyProbe.InRange(port) {
		fail(w, http.StatusBadRequest, "not a ComfyUI port")
		return 0, false
	}
	return port, true
}

func comfyError(w http.ResponseWriter, err error) {
	var up *comfy.Upstream
	var refused *comfy.Refused
	var invalid *comfy.Invalid
	switch {
	case errors.As(err, &refused):
		fail(w, refused.Status, refused.Msg)
	case errors.As(err, &up):
		fail(w, http.StatusBadGateway, up.Msg)
	case errors.As(err, &invalid):
		fail(w, http.StatusBadRequest, invalid.Msg)
	default:
		fail(w, http.StatusBadRequest, err.Error())
	}
}

func (s *Server) readComfyInstances(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	found := s.ComfyProbe.Instances(ctx)
	cards := s.cards(ctx)
	byPort := s.Docker.PortCards(ctx, cards)
	for i := range found {
		found[i].Cards = []int{}
		for _, address := range byPort[found[i].Port] {
			if j := findCard(cards, address); j >= 0 {
				found[i].Cards = append(found[i].Cards, j)
			}
		}
	}
	writeJSON(w, http.StatusOK, found)
}

// comfyVersionCheck asks now rather than waiting for the hourly pass. One
// call to ComfyUI's own repository -- not the per-node fetch the page used
// to offer, which asked GitHub once for each of forty custom nodes to
// answer a question the update button answers on its way through anyway.
func (s *Server) comfyVersionCheck(w http.ResponseWriter, r *http.Request) {
	if !s.owner(w, r) {
		return
	}
	port, ok := s.comfyPort(w, r)
	if !ok {
		return
	}
	out, err := s.ComfyProbe.LatestVersion(r.Context(), port)
	if err != nil {
		comfyError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// comfyStorage is what one instance's directories weigh on disk.
func (s *Server) comfyStorage(w http.ResponseWriter, r *http.Request) {
	port, ok := queryInt(w, r, "port", s.Ports.ComfyFirst)
	if !ok {
		return
	}
	name := s.comfyContainerName(r.Context(), port)
	if name == "" {
		fail(w, http.StatusNotFound, "找不到對應的 ComfyUI 容器")
		return
	}
	writeJSON(w, http.StatusOK, s.Comfy.Storage(comfy.SlotOf(name)))
}

// comfyContainerName is the container publishing a port: by the card
// mapping first, else the only ComfyUI container there is.
func (s *Server) comfyContainerName(ctx gocontext.Context, port int) string {
	for _, boxes := range s.Docker.ByCard(ctx, s.cards(ctx)) {
		for _, box := range boxes {
			if strings.HasPrefix(box.Name, comfy.Prefix+"-") && strings.Contains(box.Ports, fmt.Sprintf(":%d", port)) {
				return box.Name
			}
		}
	}
	var names []string
	for _, n := range s.Docker.Names(ctx) {
		if strings.HasPrefix(n, comfy.Prefix+"-") {
			names = append(names, n)
		}
	}
	if len(names) == 1 {
		return names[0]
	}
	return ""
}

func queryBool(r *http.Request, name string, fallback bool) bool {
	switch strings.ToLower(r.URL.Query().Get(name)) {
	case "":
		return fallback
	case "true", "1", "yes", "on":
		return true
	}
	return false
}

func (s *Server) comfyUpdate(w http.ResponseWriter, r *http.Request) {
	if !s.owner(w, r) {
		return
	}
	port, ok := s.comfyPort(w, r)
	if !ok {
		return
	}
	// Only a phase still in motion blocks another update; the notice of how
	// the last one went does not.
	switch s.ComfyProbe.AfterUpdate(port) {
	case "updating", "waiting", "restarting":
		fail(w, http.StatusConflict, "上一次更新還在進行，或還在等重啟")
		return
	}
	// Listening first: Manager's report of what it changed is sent once, as
	// the queue finishes, and cleared. Without it the update is followed by
	// a restart whether or not anything changed.
	watchCtx, stopWatch := gocontext.WithTimeout(gocontext.Background(), 2*time.Hour)
	results, err := s.ComfyProbe.WatchManager(watchCtx, port)
	if err != nil {
		log.Printf("ComfyUI on %d: cannot hear Manager's report (%v); will restart after the update regardless", port, err)
		results = nil
	}
	if err := s.ComfyProbe.Update(r.Context(), port, queryBool(r, "core", true), queryBool(r, "nodes", true)); err != nil {
		stopWatch()
		comfyError(w, err)
		return
	}
	name := s.comfyContainerName(r.Context(), port)
	s.ComfyProbe.SetAfterUpdate(port, "updating")
	go func() {
		defer stopWatch()
		s.restartAfterUpdate(port, name, results)
	}()
	writeJSON(w, http.StatusOK, api.OK{OK: true})
}

// restartAfterUpdate restarts the container once an update has finished
// and nothing is being drawn. Updated nodes are files on disk until the
// process that imported the old ones is gone, and an update that needs a
// second button to take effect reads as one that did nothing.
//
// The container, not Manager's reboot: Manager execs over its own process,
// which keeps the Python that already imported the old torch extensions
// and pip's half-replaced packages, and a node update that changed a
// dependency is exactly when that goes wrong. docker restart is a clean
// process from the image's own entrypoint, which also re-runs the managed
// pre-start hook.
func (s *Server) restartAfterUpdate(port int, name string, results <-chan map[string]string) {
	ctx := gocontext.Background()
	outcome, finished := s.ComfyProbe.AwaitUpdate(ctx, port, results)
	if !finished {
		log.Printf("ComfyUI on %d: update did not finish; not restarting", port)
		s.ComfyProbe.SetAfterUpdate(port, "")
		return
	}
	// Nothing changed on disk: a restart would only cost the people using it
	// half a minute. Said on the page for a few minutes, then cleared.
	if outcome.Known && len(outcome.Updated) == 0 {
		phase := "current"
		if len(outcome.Failed) > 0 {
			phase = "failed-nodes"
		}
		log.Printf("ComfyUI on %d: update checked %d, changed none, %d failed (%s); not restarting",
			port, outcome.Checked, len(outcome.Failed), strings.Join(outcome.Failed, ", "))
		s.ComfyProbe.SetUpdateOutcome(port, phase, outcome)
		time.AfterFunc(5*time.Minute, func() {
			if s.ComfyProbe.AfterUpdate(port) == phase {
				s.ComfyProbe.SetAfterUpdate(port, "")
			}
		})
		return
	}
	if outcome.Known {
		log.Printf("ComfyUI on %d: update changed %d of %d (%s)", port, len(outcome.Updated), outcome.Checked,
			strings.Join(outcome.Updated, ", "))
		s.ComfyProbe.SetUpdateOutcome(port, "waiting", outcome)
	} else {
		s.ComfyProbe.SetAfterUpdate(port, "waiting")
	}
	if !s.ComfyProbe.AwaitIdle(ctx, port) {
		s.ComfyProbe.SetAfterUpdate(port, "")
		return
	}
	if name == "" {
		name = s.comfyContainerName(ctx, port)
	}
	if name == "" {
		log.Printf("ComfyUI on %d: update finished but no container publishes it; restart it by hand", port)
		s.ComfyProbe.SetAfterUpdate(port, "failed")
		return
	}
	s.ComfyProbe.SetAfterUpdate(port, "restarting")
	log.Printf("ComfyUI on %d: update finished, restarting %s", port, name)
	if !s.Docker.Control(ctx, name, "restart") {
		s.ComfyProbe.SetAfterUpdate(port, "failed")
		return
	}
	// Answering again is the end of it; a minute and a half covers a cold
	// start with forty custom nodes importing.
	deadline := time.Now().Add(3 * time.Minute)
	for time.Now().Before(deadline) {
		time.Sleep(3 * time.Second)
		for _, inst := range s.ComfyProbe.Instances(ctx) {
			if inst.Port == port && !inst.Stale && inst.Version != nil {
				s.ComfyProbe.SetAfterUpdate(port, "")
				log.Printf("ComfyUI on %d: back after the update", port)
				return
			}
		}
	}
	s.ComfyProbe.SetAfterUpdate(port, "")
}

func (s *Server) comfyRestart(w http.ResponseWriter, r *http.Request) {
	if !s.owner(w, r) {
		return
	}
	port, ok := s.comfyPort(w, r)
	if !ok {
		return
	}
	s.ComfyProbe.Restart(r.Context(), port)
	writeJSON(w, http.StatusOK, api.OK{OK: true})
}

// comfyStop stops the container, after letting the instance finish
// stopping: the queue is emptied and the current generation interrupted
// first, so docker's ten-second grace does not end in a kill mid-step.
func (s *Server) comfyStop(w http.ResponseWriter, r *http.Request) {
	if _, d := s.Auth.RequireOwner(r); d != nil {
		denied(w, d)
		return
	}
	port, ok := s.comfyPort(w, r)
	if !ok {
		return
	}
	ctx := r.Context()
	name := s.comfyContainerName(ctx, port)
	if name == "" {
		fail(w, http.StatusNotFound, "找不到對應的 ComfyUI 容器")
		return
	}
	s.ComfyProbe.Quiesce(ctx, port, 15*time.Second)
	if !s.Docker.Control(ctx, name, "stop") {
		fail(w, http.StatusBadGateway, "docker stop 失敗，詳細原因在主控台的日誌裡")
		return
	}
	writeJSON(w, http.StatusOK, api.OK{OK: true})
}

func (s *Server) comfyInterrupt(w http.ResponseWriter, r *http.Request) {
	port, ok := s.comfyPort(w, r)
	if !ok {
		return
	}
	done, err := s.ComfyProbe.Interrupt(r.Context(), port)
	if err != nil {
		comfyError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, api.OK{OK: done})
}

// comfyConfig is what one instance's container is made of. Every card in
// the machine is listed, because the question is which ones it should have.
func (s *Server) comfyConfig(w http.ResponseWriter, r *http.Request) {
	if _, d := s.Auth.RequireOwner(r); d != nil {
		denied(w, d)
		return
	}
	port, ok := queryInt(w, r, "port", s.Ports.ComfyFirst)
	if !ok {
		return
	}
	ctx := r.Context()
	cards := s.cards(ctx)
	held := s.Docker.ByCard(ctx, cards)
	name := s.comfyContainerName(ctx, port)
	if name == "" {
		fail(w, http.StatusNotFound, "找不到對應的 ComfyUI 容器")
		return
	}
	info := s.Docker.Inspect(ctx, []string{name})[name]
	hostConfig, _ := info["HostConfig"].(map[string]any)
	config, _ := info["Config"].(map[string]any)
	devs := []string{}
	if list, _ := hostConfig["Devices"].([]any); list != nil {
		seen := map[string]bool{}
		for _, item := range list {
			e, _ := item.(map[string]any)
			p, _ := e["PathOnHost"].(string)
			if !seen[p] {
				seen[p] = true
				devs = append(devs, p)
			}
		}
	}
	sortStrings(devs)
	cliArgs := ""
	if env, _ := config["Env"].([]any); env != nil {
		for _, item := range env {
			if s, _ := item.(string); strings.HasPrefix(s, "CLI_ARGS=") {
				cliArgs = strings.TrimPrefix(s, "CLI_ARGS=")
			}
		}
	}
	image, _ := config["Image"].(string)
	var imageSize *string
	if size, ok := s.Docker.ImageSizes(ctx)[image]; ok {
		imageSize = &size
	}
	claimed := map[string]bool{}
	for key, boxes := range held {
		for _, box := range boxes {
			if box.Name == name {
				claimed[key] = true
			}
		}
	}
	out := api.ComfyConfig{Name: name, Image: image, ImageSize: imageSize, CLIArgs: cliArgs, Ports: s.Ports.ComfyPorts(),
		Devices: devs, Cards: []api.ComfyConfigCard{}}
	if bindings, _ := hostConfig["PortBindings"].(map[string]any); bindings != nil {
		for _, list := range bindings {
			items, _ := list.([]any)
			for _, item := range items {
				b, _ := item.(map[string]any)
				var n int
				if _, err := fmt.Sscanf(fmt.Sprint(b["HostPort"]), "%d", &n); err == nil {
					out.Port = &n
				}
			}
		}
	}
	if out.Port != nil {
		p := s.Channels.PublicPort(*out.Port)
		out.PublicPort = &p
	}
	for _, c := range cards {
		address := c.PCIBDFAddress
		out.Cards = append(out.Cards, api.ComfyConfigCard{PCIBDFAddress: &address, Name: c.Name, Vendor: c.Vendor,
			Held: claimed[containers.BusKey(address)]})
	}
	writeJSON(w, http.StatusOK, out)
}

func sortStrings(s []string) {
	for i := 1; i < len(s); i++ {
		for j := i; j > 0 && s[j] < s[j-1]; j-- {
			s[j], s[j-1] = s[j-1], s[j]
		}
	}
}

func (s *Server) comfyReconfigure(w http.ResponseWriter, r *http.Request) {
	if _, d := s.Auth.RequireOwner(r); d != nil {
		denied(w, d)
		return
	}
	var in struct {
		Name      string   `json:"name"`
		Addresses []string `json:"addresses"`
		CLIArgs   string   `json:"cli_args"`
		Port      any      `json:"port"`
	}
	if err := readJSON(r, &in); err != nil {
		fail(w, http.StatusUnprocessableEntity, "invalid JSON body")
		return
	}
	cards := s.cards(r.Context())
	keys := map[string]bool{}
	for _, a := range in.Addresses {
		if a != "" {
			keys[containers.BusKey(a)] = true
		}
	}
	var chosen []vendors.Card
	for _, c := range cards {
		if c.PCIBDFAddress != "" && keys[containers.BusKey(c.PCIBDFAddress)] {
			chosen = append(chosen, c)
		}
	}
	if len(chosen) == 0 {
		fail(w, http.StatusBadRequest, "至少要選一張卡")
		return
	}
	var port *int
	switch p := in.Port.(type) {
	case float64:
		if p != 0 {
			n := int(p)
			port = &n
		}
	case string:
		var n int
		if p != "" {
			if _, err := fmt.Sscanf(p, "%d", &n); err != nil {
				fail(w, http.StatusBadRequest, "連接埠要是整數")
				return
			}
			port = &n
		}
	}
	if err := s.Comfy.Reconfigure(r.Context(), in.Name, chosen, cards, in.CLIArgs, port); err != nil {
		comfyError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, api.OK{OK: true})
}

// readRuntimes is every card in the machine and what each is for.
func (s *Server) readRuntimes(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	devices := s.Gpu.ListDevices(ctx)
	cards := cardsOf(devices)
	held := s.Docker.ByCard(ctx, cards)
	rows := s.Installer.Coverage(ctx, devices, held, containers.BusKey)
	for i := range rows {
		st := s.Comfy.State(ctx, cards, i, rows[i].Containers)
		rows[i].Comfy = &st
	}
	writeJSON(w, http.StatusOK, rows)
}

func findCard(cards []vendors.Card, address string) int {
	for i, c := range cards {
		if c.PCIBDFAddress != "" && containers.BusKey(c.PCIBDFAddress) == containers.BusKey(address) {
			return i
		}
	}
	return -1
}

func installError(w http.ResponseWriter, err error) {
	var invalid *backends.Invalid
	if errors.As(err, &invalid) {
		fail(w, http.StatusBadRequest, invalid.Msg)
		return
	}
	fail(w, http.StatusBadRequest, err.Error())
}

// setCardRole turns one of a card's two jobs on or off. Images are a
// container; models are a launcher that belongs to a backend, so the first
// On may be a pull and the switch may move two cards of one vendor.
func (s *Server) setCardRole(w http.ResponseWriter, r *http.Request) {
	if _, d := s.Auth.RequireOwner(r); d != nil {
		denied(w, d)
		return
	}
	var in struct {
		Address    string `json:"pci_bdf_address"`
		Capability string `json:"capability"`
		On         bool   `json:"on"`
		Variant    string `json:"variant"`
	}
	if err := readJSON(r, &in); err != nil {
		fail(w, http.StatusUnprocessableEntity, "invalid JSON body")
		return
	}
	ctx := r.Context()
	cards := s.cards(ctx)
	i := findCard(cards, in.Address)
	if i < 0 {
		fail(w, http.StatusNotFound, "沒有這張卡")
		return
	}
	switch in.Capability {
	case "images":
		held := s.Docker.ByCard(ctx, cards)[containers.BusKey(in.Address)]
		if len(held) == 0 {
			if !in.On {
				fail(w, http.StatusBadRequest, "這張卡上沒有 ComfyUI 容器")
				return
			}
			job, err := s.Comfy.Start(ctx, cards, i, "create", "")
			if err != nil {
				comfyError(w, err)
				return
			}
			writeJSON(w, http.StatusOK, api.JobStarted{OK: true, Job: job})
			return
		}
		verb := "stop"
		if in.On {
			verb = "start"
		}
		for _, box := range held {
			s.Docker.Control(ctx, box.Name, verb)
		}
		writeJSON(w, http.StatusOK, api.OK{OK: true})
	case "llm":
		vendor := cards[i].Vendor
		if backends.RuntimeFor(vendor) != nil {
			st := s.Installer.State(ctx, providers.LlamaCpp, vendor)
			if in.On && !st.Managed {
				variant := in.Variant
				if variant == "" {
					variant = "vendor"
				}
				rec, err := s.Installer.Install(ctx, providers.LlamaCpp, vendor, variant)
				if err != nil {
					installError(w, err)
					return
				}
				writeJSON(w, http.StatusOK, rec)
				return
			}
		}
		if err := s.Installer.Enable(ctx, providers.LlamaCpp, vendor, in.On); err != nil {
			installError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, api.OK{OK: true})
	default:
		fail(w, http.StatusBadRequest, "不認識的項目："+in.Capability)
	}
}

// comfyAction updates or removes the instance on one card.
func (s *Server) comfyAction(w http.ResponseWriter, r *http.Request) {
	if _, d := s.Auth.RequireOwner(r); d != nil {
		denied(w, d)
		return
	}
	var in struct {
		Name        string `json:"name"`
		Action      string `json:"action"`
		DeleteImage bool   `json:"delete_image"`
	}
	if err := readJSON(r, &in); err != nil {
		fail(w, http.StatusUnprocessableEntity, "invalid JSON body")
		return
	}
	ctx := r.Context()
	switch in.Action {
	case "remove":
		if err := s.Comfy.Destroy(ctx, in.Name, in.DeleteImage, true); err != nil {
			comfyError(w, err)
			return
		}
	case "update":
		cards := s.cards(ctx)
		held := s.Docker.ByCard(ctx, cards)
		found := -1
		for i, c := range cards {
			for _, box := range held[containers.BusKey(c.PCIBDFAddress)] {
				if box.Name == in.Name {
					found = i
				}
			}
		}
		if found < 0 {
			fail(w, http.StatusBadRequest, in.Name+" 沒有對應到任何一張卡")
			return
		}
		job, err := s.Comfy.Start(ctx, cards, found, "update", in.Name)
		if err != nil {
			comfyError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, api.JobStarted{OK: true, Job: job})
		return
	default:
		fail(w, http.StatusBadRequest, "不認識的動作："+in.Action)
		return
	}
	writeJSON(w, http.StatusOK, api.OK{OK: true})
}

// runtimeAction adds, updates, switches off or removes a runtime. Drivers
// are not here: installing one needs root and sometimes a reboot.
func (s *Server) runtimeAction(w http.ResponseWriter, r *http.Request) {
	if _, d := s.Auth.RequireOwner(r); d != nil {
		denied(w, d)
		return
	}
	var in struct {
		Provider    string `json:"provider"`
		Vendor      string `json:"vendor"`
		Action      string `json:"action"`
		Variant     string `json:"variant"`
		DeleteImage bool   `json:"delete_image"`
	}
	if err := readJSON(r, &in); err != nil {
		fail(w, http.StatusUnprocessableEntity, "invalid JSON body")
		return
	}
	// The per-card view only ever meant llama.cpp; the store names others.
	if in.Provider == "" {
		in.Provider = providers.LlamaCpp
	}
	ctx := r.Context()
	var err error
	switch in.Action {
	case "install":
		variant := in.Variant
		if variant == "" {
			variant = "vendor"
		}
		rec, err := s.Installer.Install(ctx, in.Provider, in.Vendor, variant)
		if err != nil {
			installError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, rec)
		return
	case "update":
		rec, err := s.Installer.Update(ctx, in.Provider, in.Vendor)
		if err != nil {
			installError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, rec)
		return
	case "enable", "disable":
		if in.Action == "disable" && s.lastOfDefault(in.Provider, in.Vendor) {
			err = &backends.Invalid{Msg: "llama.cpp 是預設引擎，至少要留一個能用的，不能停用最後一個"}
			break
		}
		err = s.Installer.Enable(ctx, in.Provider, in.Vendor, in.Action == "enable")
	case "remove":
		if s.lastOfDefault(in.Provider, in.Vendor) {
			err = &backends.Invalid{Msg: "llama.cpp 是預設引擎，至少要留一個能用的，不能移除最後一個"}
			break
		}
		err = s.Installer.Remove(ctx, in.Provider, in.Vendor, in.DeleteImage)
	default:
		err = &backends.Invalid{Msg: "不認識的動作：" + in.Action}
	}
	if err != nil {
		installError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, api.OK{OK: true})
}

// loadModel forces a model resident by sending it a trivial request, after
// clearing ComfyUI off the card if it is in the way.
func (s *Server) loadModel(w http.ResponseWriter, r *http.Request) {
	modelID := r.PathValue("id")
	if status, detail := s.makeRoom(r.Context(), modelID); status != 0 {
		fail(w, status, detail)
		return
	}
	body, _ := json.Marshal(map[string]any{
		"model": modelID, "messages": []map[string]string{{"role": "user", "content": "hi"}}, "max_tokens": 1,
	})
	ctx, cancel := gocontext.WithTimeout(r.Context(), 900*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, s.LlamaSwap.Base+"/v1/chat/completions", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := (&http.Client{}).Do(req)
	if err != nil {
		fail(w, http.StatusBadGateway, err.Error())
		return
	}
	resp.Body.Close()
	writeJSON(w, http.StatusOK, api.LoadResult{OK: resp.StatusCode == 200, Status: resp.StatusCode})
}

// targetCard is the card a model will load onto: the entry's own selector
// resolved against what llama-server enumerates, else the first device a
// launcher offers, else the first card.
func (s *Server) targetCard(ctx gocontext.Context, modelID string, devices []api.GpuDevice) *api.GpuDevice {
	if len(devices) == 0 {
		return nil
	}
	env := map[string]string{}
	if spec := s.Models.ReadSpec(modelID); spec != nil {
		env = spec.Env
	}
	usable := backends.Match(s.Backends.Usable(ctx, false), devices)
	var chosen *api.BackendDevice
	for i := range usable {
		d := usable[i]
		if len(d.Env) == 0 {
			continue
		}
		all := true
		for k, v := range d.Env {
			if env[k] != v {
				all = false
			}
		}
		if all {
			chosen = &d
			break
		}
	}
	if chosen == nil && len(usable) > 0 {
		chosen = &usable[0]
	}
	if chosen != nil && chosen.PCIBDFAddress != nil && *chosen.PCIBDFAddress != "" {
		wanted := containers.BusKey(*chosen.PCIBDFAddress)
		for i := range devices {
			if devices[i].PCIBDFAddress != nil && containers.BusKey(*devices[i].PCIBDFAddress) == wanted {
				return &devices[i]
			}
		}
	}
	return &devices[0]
}

// sharesCard says whether an instance is on the card llama-server uses:
// by PCI address where the container mapping reaches, by name otherwise.
// Unknown means yes; failing to free a card that needed it is an
// out-of-memory on load.
func sharesCard(inst api.ComfyInstance, card *api.GpuDevice, byPort map[int][]string) bool {
	if card == nil {
		return true
	}
	address := ""
	if card.PCIBDFAddress != nil {
		address = *card.PCIBDFAddress
	}
	if held := byPort[inst.Port]; address != "" && len(held) > 0 {
		for _, a := range held {
			if containers.BusKey(a) == containers.BusKey(address) {
				return true
			}
		}
		return false
	}
	name := ""
	if card.Name != nil {
		name = strings.TrimSpace(*card.Name)
	}
	text, _ := inst.Device["name"].(string)
	text = strings.TrimSpace(text)
	if name == "" || text == "" {
		return true
	}
	return strings.Contains(strings.ToLower(text), strings.ToLower(name))
}

// makeRoom clears ComfyUI off the card if this model is about to need it.
// Nothing happens in the common case; a 503 is returned rather than a wait
// when ComfyUI is mid-generation. Returns a status and detail, or 0.
func (s *Server) makeRoom(ctx gocontext.Context, modelID string) (int, string) {
	if modelID == "" {
		return 0, ""
	}
	// An aliased name is a different string for a model that may already be
	// loaded; resolved so every Codex request does not look like a cold load.
	modelID = s.Config.CanonicalModel(modelID)
	for _, entry := range s.LlamaSwap.Running(ctx) {
		if m, _ := entry["model"].(string); m == modelID {
			return 0, ""
		}
	}
	s.vramMu.Lock()
	defer s.vramMu.Unlock()

	idle := float64(s.Settings.Get("comfyui_idle_gib")) * (1 << 30)
	anywhere := s.ComfyProbe.HeldVRAM(ctx, idle)
	if len(anywhere) == 0 {
		return 0, ""
	}
	devices := s.Gpu.ListDevices(ctx)
	target := s.targetCard(ctx, modelID, devices)
	byPort := s.Docker.PortCards(ctx, cardsOf(devices))
	var held []comfy.Held
	for _, h := range anywhere {
		if sharesCard(h.Instance, target, byPort) {
			held = append(held, h)
		}
	}
	if len(held) == 0 {
		return 0, ""
	}
	var total, used float64
	if target != nil {
		if sample := s.Gpu.Sample(ctx, target.Index); sample != nil {
			if sample.MemoryTotalMiB != nil {
				total = *sample.MemoryTotalMiB * (1 << 20)
			}
			if sample.MemoryUsedMiB != nil {
				used = *sample.MemoryUsedMiB * (1 << 20)
			}
		}
	}
	need := float64(s.Settings.Get("vram_margin_gib")) * (1 << 30)
	if files, ok := s.Models.FilesForModel(modelID); ok {
		for _, f := range files {
			need += float64(f.SizeBytes)
		}
	}
	if total > 0 && total-used >= need {
		return 0, ""
	}
	var busy []string
	for _, h := range held {
		if h.Instance.QueueRunning > 0 || h.Instance.QueuePending > 0 {
			busy = append(busy, fmt.Sprintf(":%d", h.Instance.Port))
		}
	}
	if len(busy) > 0 {
		return http.StatusServiceUnavailable, "ComfyUI（" + strings.Join(busy, "、") + "）正在算圖，佔著顯示卡。等它跑完，或先在 ComfyUI 介面中斷，再送這個請求。"
	}
	for _, h := range held {
		log.Printf("freeing %.1f GiB from ComfyUI :%d to make room for %s", h.Bytes/(1<<30), h.Instance.Port, modelID)
		if err := s.ComfyProbe.Free(ctx, h.Instance.Port); err != nil {
			log.Printf("could not ask ComfyUI :%d to free: %v", h.Instance.Port, err)
		}
	}
	// Waited for rather than assumed: /free returns as soon as the flag is
	// set, and llama-server would allocate against memory not yet released.
	for i := 0; i < 60; i++ {
		select {
		case <-ctx.Done():
			return 0, ""
		case <-time.After(500 * time.Millisecond):
		}
		still := false
		for _, h := range s.ComfyProbe.HeldVRAM(ctx, idle) {
			if sharesCard(h.Instance, target, byPort) {
				still = true
			}
		}
		if !still {
			log.Print("ComfyUI released the card")
			return 0, ""
		}
	}
	log.Printf("ComfyUI still holds VRAM after 30s; loading %s anyway", modelID)
	return 0, ""
}

// lastOfDefault says whether a launcher is the default engine's only one:
// a model form defaults to it, so taking it away leaves nothing to make a
// model with. A build compiled on this machine and registered by hand
// counts, since it serves the same models.
func (s *Server) lastOfDefault(key, vendor string) bool {
	p := providers.Get(key)
	if p == nil || !p.Default {
		return false
	}
	target := p.Macro(vendor)
	others, isOne := 0, false
	for _, l := range s.Config.LauncherList() {
		owner, _, managed := providers.Resolve(l.Name)
		if managed && owner.Key != p.Key {
			continue
		}
		if !managed && p.Key != providers.LlamaCpp {
			continue
		}
		if l.Name == target {
			isOne = true
		} else {
			others++
		}
	}
	return isOne && others == 0
}
