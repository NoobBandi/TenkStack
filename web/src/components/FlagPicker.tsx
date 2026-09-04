/**
 * A field for launch flags, offering whatever the installed binary has.
 *
 * The list is not written here. Both places that needed one used to carry a
 * curated selection in the source, which is correct on the machine it was
 * written on and wrong on anybody else's: llama.cpp moves its flags between
 * builds -- the local one's help names five that have been removed -- and a
 * different version, backend or image has a different set. Offering somebody a
 * switch their build does not have means a server that refuses to start and
 * nothing on screen connecting the two.
 *
 * So the backend asks the program and this shows the answer, grouped the way
 * that program groups it and described in its own words.
 *
 * Ordered by whether the program gave the flag an abbreviation, which is its
 * own statement about what people type often -- a better signal than a list of
 * favourites kept here, and one that stays right when upstream changes its mind.
 *
 * The menu inserts; the box holds. This was a tag select, where picking a flag
 * turned it into a chip -- and a chip cannot be typed into, so every flag that
 * takes a value became unusable the moment it was chosen. More than half of
 * them take a value. The list is a way to find a flag and put it in the text,
 * and the text stays text.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Input, Select, Typography } from 'antd';
import type { TextAreaRef } from 'antd/es/input/TextArea';
import { fetchFlags, type LaunchFlag } from '../api';
import { MONO } from '../theme';

const { Text } = Typography;

interface Props {
  /** Which program's flags: the model launcher, or one ComfyUI container. */
  source: { kind: 'llama-server' } | { kind: 'comfyui'; container: string };
  value?: string;
  onChange?: (value: string) => void;
  placeholder?: string;
  /** Written by the console itself from a field of its own. Offered nowhere,
   *  because a second copy would be a second opinion. */
  reserved?: string[];
  rows?: number;
}

export default function FlagPicker({
  source, value = '', onChange, placeholder, reserved = [], rows = 3,
}: Props) {
  const [flags, setFlags] = useState<LaunchFlag[]>([]);
  const box = useRef<TextAreaRef>(null);
  const key = source.kind === 'comfyui' ? source.container : 'llama-server';

  useEffect(() => {
    let live = true;
    fetchFlags(source).then((f) => { if (live) setFlags(f); }).catch(() => undefined);
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source.kind, key]);

  const options = useMemo(() => {
    /**
     * The ones with a short alias first.
     *
     * Which flags matter is a judgement, and rather than making it here it is
     * read off what the program already decided: llama.cpp gives an
     * abbreviation to the switches it expects people to type, and 79 of its 256
     * have one. That ordering comes from upstream and stays right when upstream
     * changes its mind, which a list of favourites kept here would not.
     *
     * Within each half the program's own printing order is left alone -- it
     * groups related flags together, and re-sorting would scatter them.
     */
    const abbreviated: { value: string; label: React.ReactNode }[] = [];
    const rest: { value: string; label: React.ReactNode }[] = [];

    for (const flag of flags) {
      const long = flag.names.find((n) => n.startsWith('--')) ?? flag.names[0];
      if (!long || long === '--help' || reserved.includes(long)) continue;
      const short = flag.names.find((n) => !n.startsWith('--'));
      const option = {
        value: long,
        label: (
          <span>
            {short && (
              <Text type="secondary" style={{ fontFamily: MONO, fontSize: 12 }}>
                {short}{' '}
              </Text>
            )}
            <Text style={{ fontFamily: MONO, fontSize: 12 }}>{long}</Text>
            {flag.takes_value && (
              <Text type="secondary" style={{ fontFamily: MONO, fontSize: 12 }}> N</Text>
            )}
            {flag.help && (
              <Text type="secondary" style={{ fontSize: 11 }}>　{flag.help}</Text>
            )}
          </span>
        ),
      };
      (short ? abbreviated : rest).push(option);
    }

    return [
      { label: `有縮寫（${abbreviated.length}）`, options: abbreviated },
      { label: `其他（${rest.length}）`, options: rest },
    ].filter((g) => g.options.length);
  }, [flags, reserved]);

  const takesValue = useMemo(
    () => new Set(flags.filter((f) => f.takes_value).flatMap((f) => f.names)),
    [flags],
  );

  const insert = (name: string) => {
    // Its own line. These are read back as a list, and a flag appended to the
    // end of another one's value would belong to that value.
    const trimmed = value.replace(/\s+$/, '');
    const next = `${trimmed ? `${trimmed}\n` : ''}${name}${takesValue.has(name) ? ' ' : ''}`;
    onChange?.(next);
    // The caret goes where the value would be typed, because for a flag that
    // takes one the picking is not the end of the job.
    requestAnimationFrame(() => {
      const el = box.current?.resizableTextArea?.textArea;
      if (!el) return;
      el.focus();
      el.setSelectionRange(next.length, next.length);
    });
  };

  return (
    <div>
      <Select<string>
        showSearch
        // Never holds a selection: it is a way in, not a place things live.
        value={undefined}
        onSelect={(name) => insert(name)}
        options={options}
        optionFilterProp="value"
        placeholder={flags.length
          ? `加入旗標…（這個 build 有 ${flags.length} 個）`
          : '讀不到旗標清單，直接在下面打字'}
        disabled={!flags.length}
        style={{ width: '100%', marginBottom: 8 }}
      />
      <Input.TextArea
        ref={box}
        value={value}
        onChange={(e) => onChange?.(e.target.value)}
        autoSize={{ minRows: rows, maxRows: 12 }}
        placeholder={placeholder}
        style={{ fontFamily: MONO, fontSize: 12 }}
      />
    </div>
  );
}
