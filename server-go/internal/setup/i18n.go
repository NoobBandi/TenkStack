// Package setup is the installer's interactive half: `tenkstack setup`
// asks what to install in a terminal UI and hands the answers back to
// install.sh, which does the installing; `tenkstack provision` installs
// the engines and ComfyUI instances chosen there once the console is up.
//
// Everything the user reads comes in English and Traditional Chinese, and
// the first thing the setup asks is which.
package setup

import (
	"fmt"
	"os"
	"strings"
)

// Lang is a language the installer speaks.
type Lang string

const (
	English Lang = "en"
	Chinese Lang = "zh-TW"
)

// ParseLang reads a --lang value or a locale; "" when it names neither.
func ParseLang(s string) Lang {
	s = strings.ToLower(strings.TrimSpace(s))
	switch {
	case s == "en" || strings.HasPrefix(s, "en_") || strings.HasPrefix(s, "en-"):
		return English
	case s == "zh" || s == "zh-tw" || strings.HasPrefix(s, "zh_tw") || strings.HasPrefix(s, "zh_hk") ||
		strings.HasPrefix(s, "zh-hk") || strings.HasPrefix(s, "zh_hant") || strings.HasPrefix(s, "zh-hant"):
		return Chinese
	}
	return ""
}

// DefaultLang is the language to offer first: the locale's when it is
// Traditional Chinese, English otherwise.
func DefaultLang() Lang {
	for _, v := range []string{"LC_ALL", "LC_MESSAGES", "LANG"} {
		if l := ParseLang(os.Getenv(v)); l != "" {
			return l
		}
	}
	return English
}

// messages holds every string, English then Chinese. A key missing from
// either is a test failure, not a blank on screen.
var messages = map[string][2]string{
	"lang.title":        {"Language / 語言", "Language / 語言"},
	"lang.desc":         {"The installer and its messages will use this language.", "安裝程式與之後的訊息都會用這個語言。"},
	"welcome.title":     {"TenkStack setup", "TenkStack 安裝"},
	"welcome.found":     {"Found", "偵測到"},
	"welcome.nocards":   {"no graphics card (models will run on the CPU, slowly)", "沒有顯示卡（模型會用 CPU 跑，很慢）"},
	"welcome.ram":       {"RAM", "記憶體"},
	"welcome.keys":      {"Enter goes on, Shift+Tab goes back, Space ticks a box. Nothing is installed until the plan at the end is confirmed.", "Enter 下一步、Shift+Tab 上一步、空白鍵勾選。最後的計畫確認之前，什麼都不會安裝。"},
	"dir.title":         {"Install directory", "安裝目錄"},
	"dir.desc":          {"Models, settings and the console live here.", "模型、設定與主控台都放在這裡。"},
	"dir.empty":         {"Enter a directory.", "請輸入目錄。"},
	"dir.relative":      {"Use an absolute path or one starting with ~/.", "請用絕對路徑，或以 ~/ 開頭。"},
	"engines.title":     {"Inference engines", "推論引擎"},
	"engines.desc":      {"Engines are pulled as container images after the console starts. More can be added later on the Engines page.", "主控台啟動後以容器映像下載。之後也能在「推論引擎」頁再裝。"},
	"engines.none":      {"No engine has a build for the cards found here.", "偵測到的顯示卡沒有可用的推論引擎版本。"},
	"engine.llamacpp":   {"GGUF models on any card; can offload part of a model to the CPU", "GGUF 模型，任何顯示卡都能跑，也能把一部分放到 CPU"},
	"engine.vllm":       {"Hugging Face safetensors, fastest with many users at once (several GB)", "Hugging Face safetensors，多人同時使用最快（數 GB）"},
	"engine.sglang":     {"Hugging Face safetensors, strong on long chats and shared prefixes (several GB)", "Hugging Face safetensors，長對話與共用前綴快（數 GB）"},
	"engine.unverified": {"not verified on this vendor's cards", "尚未在這家廠商的卡上驗證"},
	"engine.required":   {"default engine", "預設引擎"},
	"comfy.title":       {"ComfyUI (image generation)", "ComfyUI（生圖）"},
	"comfy.desc":        {"One instance per card, about 12 GB of image each. Leave all unticked to skip.", "每張卡一個，映像約 12 GB。都不勾就不裝。"},
	"comfy.xpusmi":      {"xpu-smi was not found: the console cannot see Intel cards without it, so ComfyUI will be skipped until it is installed.", "找不到 xpu-smi：主控台沒有它就看不到 Intel 卡，ComfyUI 會先跳過，裝好後再到 ComfyUI 頁開啟。"},
	"searxng.title":     {"Install SearXNG?", "安裝 SearXNG？"},
	"searxng.desc":      {"A private search engine in Docker, so models can search the web.", "Docker 裡的私人搜尋引擎，讓模型能上網搜尋。"},
	"access.title":      {"How is the console reached?", "主控台怎麼連？"},
	"access.http":       {"HTTP — something in front already handles TLS, or it stays on the LAN", "HTTP：前面已有處理 TLS 的代理，或只在區網用"},
	"access.internal":   {"HTTPS with Caddy's own CA — each device trusts it once", "HTTPS，Caddy 自簽 CA：每台裝置要信任一次"},
	"access.domain":     {"HTTPS with a public domain (Let's Encrypt; ports 80/443 reachable)", "HTTPS，公開網域（Let's Encrypt；80/443 要對外可達）"},
	"domain.title":      {"Domain name", "網域名稱"},
	"domain.invalid":    {"Enter a name such as ai.example.com.", "請輸入像 ai.example.com 這樣的名稱。"},
	"yes":               {"Yes", "要"},
	"no":                {"No", "不要"},
	"review.title":      {"Review", "確認"},
	"review.continue":   {"Continue to the install plan", "繼續，看安裝計畫"},
	"review.cancel":     {"Cancel", "取消"},
	"review.dir":        {"Directory", "安裝目錄"},
	"review.engines":    {"Engines", "推論引擎"},
	"review.comfy":      {"ComfyUI", "ComfyUI"},
	"review.searxng":    {"SearXNG", "SearXNG"},
	"review.access":     {"Access", "連線方式"},
	"review.none":       {"none", "無"},
	"review.domain":     {"HTTPS for %s (Let's Encrypt)", "HTTPS，%s（Let's Encrypt）"},
	"review.next":       {"The next screen lists every system change, what needs sudo and whether a reboot is needed.", "下一個畫面會列出所有系統變更、哪些要 sudo、需不需要重開機。"},
	"action.title":      {"What would you like to do?", "要做什麼？"},
	"action.found":      {"TenkStack is installed in %s.", "這台機器已經裝了 TenkStack，位置在 %s。"},
	"action.install":    {"Install or update", "安裝或更新"},
	"action.uninstall":  {"Uninstall", "解除安裝"},
	"un.keep.title":     {"The install directory", "安裝目錄"},
	"un.keep.desc":      {"It holds the models, ComfyUI files, settings and chat history.", "裡面有模型、ComfyUI 的檔案、設定與對話紀錄。"},
	"un.keep.keep":      {"Keep it — installing again picks it up", "保留：之後重裝會沿用"},
	"un.keep.purge":     {"Delete it, models included", "刪除，包含模型"},
	"un.images.title":   {"Remove the container images too?", "也刪除容器映像？"},
	"un.images.desc":    {"The engines' and ComfyUI's images, usually tens of GB. Images another container still uses are kept.", "推論引擎與 ComfyUI 的映像，通常有幾十 GB。還有其他容器在用的會保留。"},
	"un.next":           {"The next screen lists everything that will be removed and asks once more.", "下一個畫面會列出所有會移除的東西，再確認一次。"},
	"cancelled":         {"Cancelled. Nothing was changed.", "取消了，什麼都沒有動。"},

	"prov.start":       {"Installing what was chosen", "安裝選好的元件"},
	"prov.locked":      {"The console already has accounts, so this cannot install for you. Sign in and use the Engines and ComfyUI pages.", "主控台已經有帳號，這一步無法代為安裝。請登入後到「推論引擎」與「ComfyUI」頁安裝。"},
	"prov.unreachable": {"The console did not answer at %s.", "連不到主控台（%s）。"},
	"prov.engine":      {"%s for %s", "%s（%s）"},
	"prov.already":     {"already installed", "已經裝好"},
	"prov.pulling":     {"downloading", "下載中"},
	"prov.writing":     {"setting up", "設定中"},
	"prov.starting":    {"starting", "啟動中"},
	"prov.done":        {"done", "完成"},
	"prov.failed":      {"failed: %s", "失敗：%s"},
	"prov.unknown":     {"no engine is called %s", "沒有叫 %s 的推論引擎"},
	"prov.nobuild":     {"no build for these cards", "這些卡沒有可用版本"},
	"prov.comfy":       {"ComfyUI on %s", "ComfyUI（%s）"},
	"prov.nocard":      {"the console cannot see this card; install the vendor's tools (xpu-smi for Intel), then enable ComfyUI on the ComfyUI page", "主控台看不到這張卡；裝好廠商工具（Intel 是 xpu-smi）後，到 ComfyUI 頁開啟"},
	"prov.timeout":     {"still not finished after %s; it carries on in the console", "過了 %s 還沒完成；主控台會在背景繼續"},
	"prov.later":       {"Anything that failed can be installed later from the console.", "失敗的項目之後都能在主控台裡再裝。"},
}

// T is one message in the given language; a missing key reads as itself,
// which a test catches before a user does.
func T(l Lang, key string) string {
	m, ok := messages[key]
	if !ok {
		return key
	}
	if l == Chinese {
		return m[1]
	}
	return m[0]
}

// Tf is T with fmt.Sprintf arguments.
func Tf(l Lang, key string, args ...any) string { return fmt.Sprintf(T(l, key), args...) }
