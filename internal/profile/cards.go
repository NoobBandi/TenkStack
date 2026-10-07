package profile

import (
	"slices"
	"strconv"
	"strings"
)

// selectorVars are the environment variables that hide cards from an
// engine, by the vendor whose cards they number. ONEAPI_DEVICE_SELECTOR,
// CUDA_VISIBLE_DEVICES and HIP_VISIBLE_DEVICES are what the console itself
// writes (internal/vendors); the others are their lower-level siblings a
// hand-written entry may use instead, and they hide cards just the same.
var selectorVars = []struct{ name, vendor string }{
	{"ONEAPI_DEVICE_SELECTOR", "intel"},
	{"ZE_AFFINITY_MASK", "intel"},
	{"CUDA_VISIBLE_DEVICES", "nvidia"},
	{"HIP_VISIBLE_DEVICES", "amd"},
	{"ROCR_VISIBLE_DEVICES", "amd"},
}

// selected parses a selector's value into the card numbers it names, in
// its order. all is true for a wildcard (level_zero:*, *:gpu). An item that
// is not a number (a CUDA UUID) is counted in n but cannot be placed.
func selected(variable, value string) (ordinals []int, n int, all bool) {
	value = strings.TrimSpace(value)
	if variable == "ONEAPI_DEVICE_SELECTOR" {
		// backend:devices;backend:devices -- only Level Zero (or any
		// backend) reaches a GPU through SYCL here; opencl:cpu does not.
		var lists []string
		for _, term := range strings.Split(value, ";") {
			backend, devices, ok := strings.Cut(term, ":")
			backend = strings.ToLower(strings.TrimSpace(backend))
			// An exclusion (!level_zero:1) narrows another term; taking it
			// as an inclusion would count the very card it hides.
			if !ok || strings.HasPrefix(backend, "!") {
				continue
			}
			if backend == "level_zero" || backend == "*" {
				lists = append(lists, devices)
			}
		}
		value = strings.Join(lists, ",")
	}
	seen := map[int]bool{}
	for _, item := range strings.Split(value, ",") {
		item = strings.TrimSpace(item)
		if item == "" {
			continue
		}
		if item == "*" || strings.EqualFold(item, "gpu") {
			return nil, 0, true
		}
		// 0.1 is a sub-device (a tile) of card 0.
		whole, _, _ := strings.Cut(item, ".")
		k, err := strconv.Atoi(whole)
		if err != nil {
			n++
			continue
		}
		if !seen[k] {
			seen[k] = true
			ordinals = append(ordinals, k)
			n++
		}
	}
	return ordinals, n, false
}

// CardsUsed is the cards an entry's model runs on, in the order the engine
// numbers them. It answers what the workshop calls the card count (§6),
// which is a property of the recipe, not of the machine: a model pinned to
// one of two cards is a one-card result.
//
//  1. What the engine can see. The entry's selector variable, when it has
//     one, hides every card it does not name; without one the engine sees
//     every card of its vendor (vendor "" = every card), as llama-swap
//     starts it with the console's environment. An empty value is treated
//     as unset: the launchers only forward a selector that has a value.
//  2. What the engine takes of those. vLLM and SGLang use exactly
//     tensor-parallel x pipeline-parallel (x data-parallel) cards, the
//     first ones they see. llama.cpp uses every card it sees unless the
//     command narrows it: --device naming some (or none), --split-mode none
//     keeping only --main-gpu, a --tensor-split giving a card a zero share.
//     Strata and unknown engines are taken to use all they can see, which
//     is what the Strata launcher does on this machine.
func CardsUsed(cards []Card, env map[string]string, args []string, engine, vendor string) []Card {
	visible := visibleCards(cards, env, vendor)
	switch engine {
	case "vllm", "sglang":
		n := parallelism(args, engine)
		if n < len(visible) {
			visible = visible[:n]
		}
	case "llamacpp":
		visible = llamaCards(visible, args)
	}
	return visible
}

func visibleCards(cards []Card, env map[string]string, vendor string) []Card {
	var out []Card
	pinned := false
	for _, sv := range selectorVars {
		value, ok := env[sv.name]
		if !ok || strings.TrimSpace(value) == "" {
			continue
		}
		pinned = true
		var mine []Card
		for _, c := range cards {
			if c.Vendor == sv.vendor {
				mine = append(mine, c)
			}
		}
		ordinals, n, all := selected(sv.name, value)
		if all {
			out = append(out, mine...)
			continue
		}
		var picked []Card
		for _, k := range ordinals {
			if i := slices.IndexFunc(mine, func(c Card) bool { return c.Ordinal == k }); i >= 0 {
				picked = append(picked, mine[i])
			}
		}
		// Named but not placed (a UUID, a number this machine does not
		// have): the count is still right if the first cards stand in.
		if len(picked) < n {
			for _, c := range mine {
				if len(picked) == n {
					break
				}
				if !slices.Contains(picked, c) {
					picked = append(picked, c)
				}
			}
		}
		out = append(out, picked...)
	}
	if pinned {
		return out
	}
	for _, c := range cards {
		if vendor == "" || c.Vendor == vendor {
			out = append(out, c)
		}
	}
	return out
}

// parallelism is how many cards a vLLM or SGLang server shards over.
func parallelism(args []string, engine string) int {
	get := func(names ...string) int {
		v, ok := Flag(args, names...)
		if !ok {
			return 1
		}
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 {
			return 1
		}
		return n
	}
	if engine == "sglang" {
		n := get("--tensor-parallel-size", "--tp-size", "--tp") * get("--pipeline-parallel-size", "--pp-size")
		// Without DP attention each data-parallel replica is a full
		// tensor-parallel group of its own; with it, they share the group.
		if !Has(args, "--enable-dp-attention") {
			n *= get("--data-parallel-size", "--dp-size", "--dp")
		}
		return n
	}
	return get("--tensor-parallel-size", "-tp") * get("--pipeline-parallel-size", "-pp") * get("--data-parallel-size", "-dp")
}

// llamaCards narrows what llama.cpp sees to what the command uses. Device
// numbers in these flags count the visible cards, after the selector.
func llamaCards(visible []Card, args []string) []Card {
	if v, ok := Flag(args, "--device", "-dev"); ok {
		if strings.EqualFold(strings.TrimSpace(v), "none") {
			return nil
		}
		var out []Card
		for _, name := range strings.Split(v, ",") {
			// SYCL0, CUDA1, Vulkan0: the backend's name and the number.
			digits := strings.TrimLeftFunc(strings.TrimSpace(name), func(r rune) bool { return r < '0' || r > '9' })
			if k, err := strconv.Atoi(digits); err == nil && k < len(visible) && !slices.Contains(out, visible[k]) {
				out = append(out, visible[k])
			}
		}
		visible = out
	}
	if mode, _ := Flag(args, "--split-mode", "-sm"); strings.EqualFold(mode, "none") {
		main := 0
		if v, ok := Flag(args, "--main-gpu", "-mg"); ok {
			main, _ = strconv.Atoi(v)
		}
		if main >= 0 && main < len(visible) {
			return visible[main : main+1]
		}
		return visible[:min(1, len(visible))]
	}
	if v, ok := Flag(args, "--tensor-split", "-ts"); ok {
		shares := strings.FieldsFunc(v, func(r rune) bool { return r == ',' || r == '/' })
		var out []Card
		for i, c := range visible {
			// A card past the list gets no share, as llama.cpp fills the
			// rest with zeros.
			if i < len(shares) {
				if f, err := strconv.ParseFloat(strings.TrimSpace(shares[i]), 64); err == nil && f > 0 {
					out = append(out, c)
				}
			}
		}
		if len(out) > 0 {
			visible = out
		}
	}
	return visible
}
