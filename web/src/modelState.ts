/**
 * A model's state as llama-swap names it, and as this interface says it.
 *
 * The raw words -- stopped, starting, ready, stopping -- were printed as
 * they came, English in an interface that is otherwise Chinese, and
 * "stopped" read as though something had failed when it only means the
 * model is not in memory.
 */
export const STATE_COLOURS: Record<string, string> = {
  ready: 'green', starting: 'processing', stopping: 'orange', stopped: 'default',
};

export const STATE_LABELS: Record<string, string> = {
  ready: '已載入', starting: '載入中', stopping: '卸載中', stopped: '未載入',
};

export const stateLabel = (state: string) => STATE_LABELS[state] ?? state;
