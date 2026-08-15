import { theme, type ThemeConfig } from 'antd';

/**
 * A monochrome instrument panel.
 *
 * Colour is spent only where it carries meaning — a warning, an error, a live
 * indicator. Everything structural is white on black at varying opacity, so
 * when something does turn amber or red it is the only coloured thing on the
 * screen and cannot be missed. Charts are the one exception: their series carry
 * hue, drawn from a cool set kept clear of the status colours (see SERIES).
 */

export const MONO =
  "ui-monospace, 'SF Mono', SFMono-Regular, Menlo, 'Noto Sans Mono CJK TC', monospace";

/** Structural greys, as opacities of white so they compose on any surface. */
export const LINE = {
  faint: 'rgba(255,255,255,0.07)',
  soft: 'rgba(255,255,255,0.13)',
  medium: 'rgba(255,255,255,0.22)',
  strong: 'rgba(255,255,255,0.45)',
};

export const ACCENT = {
  warn: '#e0a83c',
  error: '#e05c5c',
  ok: '#5ccf8f',
};

/**
 * Chart series colours.
 *
 * A cool set, deliberately clear of ACCENT: amber, red and green mean warning,
 * error and running everywhere else in the console, and a trace that happens to
 * be amber would read as a state rather than as a quantity. Muted rather than
 * saturated, because they sit on near-black and a pure hue at full chroma
 * glares the same way the white button did.
 *
 * Dash patterns are kept alongside them rather than replaced by them, so the
 * series stay separable in a screenshot, on a projector, or to a reader who
 * cannot pick the hues apart.
 */
export const SERIES = {
  vram: '#6ea8fe',
  power: '#c79bf0',
  temp: '#6fd0c4',
};

/** Per-device traces, in device order. */
export const DEVICE_SERIES = ['#6ea8fe', '#c79bf0', '#6fd0c4', '#e08bb0'];

/**
 * Log sources.
 *
 * Cool again, and for the same reason: amber and red already mean warning and
 * error on every log row, so a source tinted amber would read as a severity.
 * Assigned by name rather than by arrival order, so a service keeps its colour
 * whether or not it has said anything yet.
 */
export const SOURCE_COLOURS: Record<string, string> = {
  模型: '#6ea8fe',
  代理: '#c79bf0',
  主控台: '#6fd0c4',
  圖像: '#e08bb0',
  系統: 'rgba(242,242,242,0.45)',
};

const shared: ThemeConfig['token'] = {
  // Small radii and tight spacing read as an instrument rather than a consumer
  // app, which is what this is.
  borderRadius: 4,
  borderRadiusLG: 6,
  borderRadiusSM: 3,
  fontSize: 14,
  wireframe: false,
};

/**
 * Surfaces, darkest first. Kept as flat greys with equal channels: the base
 * used to be #0a0a0b, and antd derives its whole neutral scale from it, so that
 * single unit of blue came back as #1c1c22 on every table and input -- a violet
 * cast against the neutral white-alpha rules drawn over it.
 */
const SURFACE = {
  sider: '#080808',
  page: '#0a0a0a',
  card: '#0f0f0f',
  /** Inputs, selects, popovers: one step above the card they sit on. */
  container: '#141414',
  elevated: '#1a1a1a',
};

export const darkTheme: ThemeConfig = {
  algorithm: theme.darkAlgorithm,
  token: {
    ...shared,
    colorBgBase: SURFACE.page,
    colorTextBase: '#f2f2f2',
    // White as the primary: the interface has no brand colour, and reserving
    // hue for status makes status legible. Buttons dim it (see Button below) --
    // a solid #fff fill is a 20:1 glare against this background.
    colorPrimary: '#ffffff',
    colorLink: '#ffffff',
    colorBgContainer: SURFACE.container,
    colorBgElevated: SURFACE.elevated,
    colorBorder: LINE.soft,
    colorBorderSecondary: LINE.faint,
    colorWarning: ACCENT.warn,
    colorError: ACCENT.error,
    colorSuccess: ACCENT.ok,
    colorInfo: '#ffffff',
  },
  components: {
    Layout: {
      headerBg: SURFACE.page,
      bodyBg: SURFACE.page,
      siderBg: SURFACE.sider,
      headerHeight: 56,
    },
    Card: {
      colorBgContainer: SURFACE.card,
      headerBg: 'transparent',
      headerFontSize: 13,
      paddingLG: 16,
    },
    Menu: {
      itemBg: 'transparent',
      subMenuItemBg: 'transparent',
      itemSelectedBg: 'rgba(255,255,255,0.09)',
      itemSelectedColor: '#ffffff',
      itemHoverBg: 'rgba(255,255,255,0.05)',
      itemBorderRadius: 4,
      itemMarginInline: 8,
      itemHeight: 34,
      groupTitleFontSize: 11,
    },
    Table: {
      // Transparent rather than a colour of its own: a table is always inside a
      // Card here, and giving it colorBgContainer made it a lighter slab
      // floating on the card instead of part of it.
      colorBgContainer: 'transparent',
      headerBg: 'transparent',
      headerSplitColor: 'transparent',
      headerColor: 'rgba(242,242,242,0.5)',
      borderColor: LINE.faint,
      rowHoverBg: 'rgba(255,255,255,0.035)',
      expandIconBg: 'transparent',
      cellPaddingBlockSM: 7,
    },
    Button: {
      // The default type carries a hairline so actions read as controls rather
      // than text. The primary fill is dimmed from white to ~9.6:1 against the
      // page: still plainly the emphasised action, without the searing edge a
      // full-white fill has on a near-black background. primaryColor has to
      // come with it, or the label stays white on a light grey fill.
      defaultBorderColor: LINE.medium,
      primaryShadow: 'none',
      colorPrimary: '#b8b8b8',
      colorPrimaryHover: '#cdcdcd',
      colorPrimaryActive: '#a3a3a3',
      primaryColor: SURFACE.page,
    },
    Progress: { defaultColor: '#ffffff', remainingColor: 'rgba(255,255,255,0.10)' },
    Tag: { defaultBg: 'rgba(255,255,255,0.07)', defaultColor: '#d8d8da' },
    Segmented: {
      itemSelectedBg: 'rgba(255,255,255,0.12)',
      itemSelectedColor: '#ffffff',
      trackBg: 'rgba(255,255,255,0.04)',
    },
    Statistic: { contentFontSize: 26, titleFontSize: 12 },
    Tooltip: { colorBgSpotlight: '#1f1f1f' },
  },
};
