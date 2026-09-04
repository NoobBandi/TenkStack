/**
 * Chinese for the flags worth explaining, and only that.
 *
 * Which flags exist still comes from the binary -- this file cannot add one or
 * hide one, and a build with different switches is still described by its own
 * `--help`. All this does is say what the common ones are for in the language
 * the rest of the interface is written in.
 *
 * That makes the failure mode benign, which is the whole reason it is safe to
 * keep a list here at all. A flag nobody has translated shows the program's own
 * English sentence, which is never wrong and never out of date. A flag that has
 * been removed upstream simply never appears to be looked up.
 *
 * Written from each program's own help text rather than from memory, and where
 * this machine has measured something the note says the measurement instead of
 * repeating the manual.
 */

/** Keyed on the long name, which is what the picker offers. */
export const LLAMA_NOTES: Record<string, string> = {
  // Memory placement -- the reason most people open this field.
  '--cpu-moe': 'MoE 的專家權重全部留在系統記憶體。模型塞不進顯存時才用；專家權重要走 PCIe，這台實測 12 GB/s 對顯存 585 GB/s',
  '--n-cpu-moe': '只把前 N 層的 MoE 專家權重留在記憶體，比 --cpu-moe 細緻，可以剛好騰出差的那幾 GB',
  '--n-cpu-ffn': '把前 N 層的 FFN 權重留在記憶體。這個是給 dense 模型用的，MoE 請用 --n-cpu-moe',
  '--load-mode': '模型怎麼載入：mmap 省記憶體、mlock 鎖進 RAM 不被換出、mmap+mlock 兩者都要',
  '--no-mmap': '已被 --load-mode 取代。不要記憶體對映，載入較慢但之後不會有頁面錯誤',
  '--mlock': '已被 --load-mode 取代。強制把模型鎖在 RAM，不被換出到磁碟',

  // Cards.
  '--split-mode': '多卡怎麼切：layer 按層分、row 按張量分、none 只用一張。這台一律 layer——tensor 快 1.3~7.6% 但完全不能做推測解碼',
  '--tensor-split': '每張卡分到多少比例，逗號分隔。兩張卡不一樣大時才需要',
  '--main-gpu': '單卡模式下用哪一張，或多卡時中間結果放哪張',
  '--override-tensor': '指定某些張量放哪個裝置，用正則比對張量名稱。進階',

  // KV cache and context.
  '--cache-type-k': 'K 快取的資料型別。q8_0 大約省一半顯存，品質影響很小',
  '--cache-type-v': 'V 快取的資料型別。要搭配 flash attention 才有支援',
  '--kv-unified': '所有 slot 共用一份 KV 緩衝區。注意：只在 slot 數是自動決定時才預設開啟，寫了 --parallel 就會關掉',
  '--parallel': '同時處理幾個請求。context 會被平分，四個 slot 就是每個拿四分之一',
  '--keep': '壓縮上下文時，開頭保留幾個 token。-1 是全部保留',
  '--rope-scaling': 'RoPE 縮放方式（linear / yarn），用來把模型撐過原本的訓練長度',
  '--rope-scale': 'RoPE 縮放倍率。搭配 --yarn-orig-ctx 使用',
  '--yarn-orig-ctx': 'YaRN：模型原本的訓練長度，縮放是相對這個數字算的',

  // Throughput.
  '--batch-size': '一次送進去的最大 token 數（邏輯批次）',
  '--ubatch-size': '實際一次算的 token 數（物理批次）。顯存吃緊時調小這個',
  '--threads': 'CPU 執行緒數。全部放顯存時影響很小',
  '--flash-attn': 'Flash attention。省顯存也比較快，V 快取要量化就必須開',
  '--cont-batching': '連續批次：新請求不等舊的算完就插進來',
  '--no-warmup': '啟動時不跑一次空的推論。跳過會讓第一個請求變慢',

  // Speculative decoding.
  '--spec-draft-model': '推測解碼用的草稿模型。小模型先猜，大模型一次驗證多個 token',
  '--spec-type': '推測解碼的方式，逗號分隔。這台實測 DFlash2 + ngram 對 Qwen 有效，但 MTP 會讓帶 tools 的請求永久卡住',
  '--spec-draft-n-max': '一次讓草稿模型猜幾個 token',

  // Chat behaviour.
  '--jinja': '用 jinja 樣板處理對話格式。工具呼叫需要它',
  '--chat-template': '自訂對話樣板，覆蓋模型 metadata 裡的那份',
  '--chat-template-file': '同上，但從檔案讀',
  '--reasoning-format': '思考標籤怎麼處理：留著、拿掉、或抽成獨立欄位',

  // Sampling. Defaults are usually right; these are here to be recognised.
  '--temp': '溫度，越高越發散（預設 0.80）',
  '--top-k': '只從機率最高的 K 個候選裡挑（預設 40，0 是關閉）',
  '--top-p': '從累積機率到 P 的候選裡挑（預設 0.95，1.0 是關閉）',
  '--min-p': '低於最高機率 P 倍的候選直接砍掉（預設 0.05）',
  '--repeat-penalty': '重複的 token 扣分（預設 1.00，即不罰）',
  '--presence-penalty': '出現過的 token 一律扣分，不看次數',

  // Serving.
  '--slots': '開放 /slots 端點。主控台的 context 用量就是讀這個',
  '--metrics': '開放 Prometheus 格式的指標端點',
  '--check-tensors': '載入時檢查張量有沒有壞值。很慢，只在懷疑檔案損毀時用',
};

export const COMFY_NOTES: Record<string, string> = {
  '--lowvram': '模型分段搬進顯存，省顯存但較慢',
  '--novram': '連 lowvram 都不夠時用，幾乎全部放系統記憶體',
  '--highvram': '模型用完留在顯存裡，較快但一直佔著',
  '--enable-dynamic-vram': '開啟動態顯存：需要時才搬，lowvram 在這個模式下不生效',
  '--disable-dynamic-vram': '關掉動態顯存，回到固定的載入策略',
  '--gpu-only': '連文字編碼器和 VAE 都留在顯存',
  '--cpu': '完全用 CPU 跑。很慢，排除顯示卡問題時才用',
  '--reserve-vram': '留下 N GB 顯存給別人。這台跟 LLM 共用顯卡時有用',
  '--vram-headroom': '額外保留的顯存餘裕',
  '--disable-smart-memory': '用完立刻放掉，不留快取',
  '--cache-none': '不快取節點結果，最省記憶體但每次重算',
  '--cache-lru': '用 LRU 快取 N 個節點結果',
  '--fp16-vae': 'VAE 用 fp16。省顯存，但有些模型會出全黑的圖',
  '--fp32-vae': 'VAE 用完整精度',
  '--bf16-unet': '擴散模型用 bf16',
  '--cpu-vae': 'VAE 放 CPU 跑，換顯存',
  '--force-fp16': '強制 fp16',
  '--force-fp32': '強制 fp32',
  '--fast': '開啟未充分測試的加速，可能影響畫質',
  '--async-offload': '非同步搬運權重',
  '--use-pytorch-cross-attention': '用 PyTorch 內建的 cross attention',
  '--use-sage-attention': '用 Sage attention',
  '--disable-mmap': '載入 safetensors 不用記憶體對映',
  '--preview-method': '取樣過程的預覽方式：none / auto / latent2rgb / taesd',
  '--default-device': '預設用哪個裝置。這個由主控台從上面的顯示卡清單寫，不用自己填',
  '--oneapi-device-selector': 'oneAPI 裝置選擇。掛進容器的 render node 本身就是選卡了，通常不需要',
  '--disable-all-custom-nodes': '只載 ComfyUI 本體，排錯用',
  '--disable-api-nodes': '關掉需要外部 API 的節點',
  '--listen': '監聽哪個位址。由主控台的容器設定決定，不要在這裡改',
  '--port': '監聽哪個埠。同上',
};
