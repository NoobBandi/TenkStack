import { RunMark } from './BenchResults';
import './bench.css';

/** A per-run row that opens into place when it first renders and folds
 *  away when `leaving`. */
export function Row({ leaving, children, style }: {
  leaving?: boolean; children: React.ReactNode; style?: React.CSSProperties;
}) {
  return (
    <div className={`bn-row ${leaving ? 'bn-leave' : 'bn-enter'}`} style={style}>
      <div>{children}</div>
    </div>
  );
}

/** A run's letter in a slot that widens when a comparison starts and
 *  narrows to nothing when it ends, rather than appearing in one frame. */
export function MarkSlot({ mark, show, align = 'center' }: {
  mark: number; show: boolean; align?: 'center' | 'flex-start';
}) {
  return (
    <span className="bn-mark-slot" aria-hidden={!show}
          style={{ width: show ? 26 : 0, opacity: show ? 1 : 0, alignSelf: align }}>
      <RunMark index={mark} />
    </span>
  );
}
