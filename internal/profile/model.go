package profile

import (
	"path"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/NoobBandi/TenkStack/internal/hfmodel"
	"github.com/NoobBandi/TenkStack/internal/locations"
	"github.com/NoobBandi/TenkStack/internal/schema"
)

// ModelArg is the weights an entry's command names: --model (llama.cpp's
// -m, SGLang's --model-path), or vLLM's positional `serve <model>`. "" when
// the command does not say, as a script that picks its own model does not.
func ModelArg(args []string) string {
	if v, ok := Flag(args, "--model", "-m", "--model-path"); ok {
		return v
	}
	for i, a := range args {
		if a == "serve" && i+1 < len(args) && !strings.HasPrefix(args[i+1], "-") {
			return args[i+1]
		}
	}
	return ""
}

var macroRef = regexp.MustCompile(`\$\{([^}]+)\}`)

// Expand substitutes llama-swap macros the way llama-swap does; a name it
// does not know stays as written.
func Expand(raw string, macros map[string]string) string {
	return macroRef.ReplaceAllStringFunc(raw, func(m string) string {
		if v, ok := macros[m[2:len(m)-1]]; ok {
			return v
		}
		return m
	})
}

// Locate is the model location a path is in and the path within it:
// ${models-dir-2}/owner/repo/x.gguf by its macro, or an absolute path
// under a location's directory. ok is false for anything else.
func Locate(raw string, macros map[string]string, locs []locations.Location) (key, rel string, ok bool) {
	if m := locations.Pattern.FindStringSubmatch(raw); m != nil {
		return m[1], path.Clean(m[2]), true
	}
	abs := Expand(raw, macros)
	if !filepath.IsAbs(abs) {
		return "", "", false
	}
	abs = filepath.Clean(abs)
	for _, loc := range locs {
		root := filepath.Clean(loc.Path)
		if loc.Path == "" || root == "/" {
			continue
		}
		if r, err := filepath.Rel(root, abs); err == nil && r != "." && !strings.HasPrefix(r, "..") {
			return loc.Key, filepath.ToSlash(r), true
		}
	}
	return "", "", false
}

// ModelFacts are what the console read about the weights on disk.
type ModelFacts struct {
	// Precision is a safetensors model's stored precision as
	// internal/hfmodel names it from config.json: bf16, fp8, awq, int4, …
	Precision string
	// FileType is a GGUF's general.file_type from its header, -1 when it
	// was not read. Only consulted when the file's name carries no quant.
	FileType int
	// SHA256 and Revision only when the console recorded them on
	// download: hashing a multi-gigabyte file to describe a run is not
	// worth the minutes, and a revision cannot be recovered afterwards.
	SHA256, Revision string
}

// Precision is a safetensors model's stored precision from its
// config.json, named as everywhere else in the console (internal/hfmodel).
func Precision(configJSON []byte) string { return hfmodel.Parse(configJSON).Precision }

// hfName is one half of a Hugging Face repo id.
var hfName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$`)

// The Hugging Face cache's own layout, for a model loaded straight out of
// it: models--owner--name/snapshots/<commit>/file.
var hubCache = regexp.MustCompile(`(?:^|/)models--([^/]+?)--([^/]+)/snapshots/([0-9a-f]{40})(?:/(.*))?$`)

// Model is the identity of the weights an entry names (raw, as ModelArg
// returned it), as the workshop matches it (§6): GGUF by repo and file
// (or sha256), safetensors by repo, both with the quantisation.
//
// The repo is read off the path, because the catalog downloads into
// <location>/<owner>/<repo>/<file as the repo names it>: the first two
// directories under a location are the repo and the rest is the file,
// split GGUFs and quant subdirectories included. A path that is not laid
// out that way gets no repo -- a guess would match somebody else's model --
// and a GGUF then keeps only its file name. No path ever comes out.
//
// Quant is what the files are, not how the engine loads them: a bf16
// repo served with vLLM's --quantization fp8 is still bf16 here, the fp8
// is tuning (online_quantization), so both runs count as the same model.
func Model(raw string, macros map[string]string, locs []locations.Location, facts ModelFacts) schema.ModelRef {
	if raw == "" {
		return schema.ModelRef{}
	}
	out := schema.ModelRef{Format: "safetensors", SHA256: facts.SHA256, Revision: facts.Revision}
	gguf := strings.HasSuffix(strings.ToLower(raw), ".gguf")
	if gguf {
		out.Format = "gguf"
	}
	expanded := filepath.ToSlash(Expand(raw, macros))
	if m := hubCache.FindStringSubmatch(expanded); m != nil && hfName.MatchString(m[1]) && hfName.MatchString(m[2]) {
		out.Repo = m[1] + "/" + m[2]
		if out.Revision == "" {
			out.Revision = m[3]
		}
		if gguf {
			out.File = m[4]
		}
	} else if _, rel, ok := Locate(raw, macros, locs); ok {
		parts := strings.Split(rel, "/")
		switch {
		case gguf && len(parts) >= 3 && hfName.MatchString(parts[0]) && hfName.MatchString(parts[1]):
			out.Repo, out.File = parts[0]+"/"+parts[1], strings.Join(parts[2:], "/")
		case !gguf && len(parts) == 2 && hfName.MatchString(parts[0]) && hfName.MatchString(parts[1]):
			out.Repo = rel
		}
	}
	if gguf && out.File == "" {
		out.File = path.Base(expanded)
	}
	// Belt and braces for §11: whatever went wrong above, a value that
	// looks like a path or an unexpanded macro does not leave.
	for _, v := range []*string{&out.Repo, &out.File} {
		if strings.HasPrefix(*v, "/") || strings.HasPrefix(*v, "~") || strings.Contains(*v, "$") || strings.Contains(*v, "..") {
			*v = ""
		}
	}
	if gguf {
		out.Quant = GGUFQuant(expanded, facts.FileType)
	} else {
		out.Quant = strings.ToLower(facts.Precision)
	}
	return out
}

// A quant tag as GGUF publishers write it in file names: Q4_K_M, Q8_0,
// IQ3_XXS, unsloth's UD-Q6_K_XL, BF16, MXFP4. Anchored at the start; the
// caller tries every position after a separator.
var quantTag = regexp.MustCompile(`(?i)^((?:UD-)?(?:I?Q[1-8]_[0-9A-Z]+(?:_[A-Z]+)?|TQ[12]_0|MXFP4(?:_MOE)?|BF16|FP16|F16|FP32|F32))(?:[-_.]|$)`)

var shardSuffix = regexp.MustCompile(`(?i)-\d{5}-of-\d{5}$`)

// GGUFQuant is a GGUF's quantisation: the tag in its file name, else in
// the directory it sits in (unsloth puts a split GGUF in UD-IQ3_XXS/), else
// what the header's file type says. The name wins over the header because
// the header records only the base type -- every unsloth UD-Q6_K_XL file
// says Q6_K -- and the name is what people and the workshop call it.
func GGUFQuant(name string, fileType int) string {
	parts := strings.Split(filepath.ToSlash(name), "/")
	for i := len(parts) - 1; i >= 0; i-- {
		base := parts[i]
		if i == len(parts)-1 {
			base = shardSuffix.ReplaceAllString(strings.TrimSuffix(strings.TrimSuffix(base, ".gguf"), ".GGUF"), "")
		}
		if q := quantIn(base); q != "" {
			return q
		}
	}
	return fileTypes[fileType]
}

// quantIn is the tag ending last in s, the earliest-starting one of those
// so that UD-Q6_K_XL is not cut down to Q6_K_XL.
func quantIn(s string) string {
	best, bestEnd := "", -1
	for i := 0; i < len(s); i++ {
		if i > 0 && !strings.ContainsRune("-_.", rune(s[i-1])) {
			continue
		}
		m := quantTag.FindStringSubmatch(s[i:])
		if m == nil {
			continue
		}
		if end := i + len(m[1]); end > bestEnd {
			best, bestEnd = m[1], end
		}
	}
	best = strings.ToUpper(best)
	switch best {
	case "FP16":
		return "F16"
	case "FP32":
		return "F32"
	}
	return best
}

// fileTypes is llama.cpp's llama_ftype, the general.file_type a GGUF
// header records.
var fileTypes = map[int]string{
	0: "F32", 1: "F16", 2: "Q4_0", 3: "Q4_1", 7: "Q8_0", 8: "Q5_0", 9: "Q5_1",
	10: "Q2_K", 11: "Q3_K_S", 12: "Q3_K_M", 13: "Q3_K_L", 14: "Q4_K_S", 15: "Q4_K_M",
	16: "Q5_K_S", 17: "Q5_K_M", 18: "Q6_K", 19: "IQ2_XXS", 20: "IQ2_XS", 21: "Q2_K_S",
	22: "IQ3_XS", 23: "IQ3_XXS", 24: "IQ1_S", 25: "IQ4_NL", 26: "IQ3_S", 27: "IQ3_M",
	28: "IQ2_S", 29: "IQ2_M", 30: "IQ4_XS", 31: "IQ1_M", 32: "BF16", 36: "TQ1_0",
	37: "TQ2_0", 38: "MXFP4_MOE",
}
