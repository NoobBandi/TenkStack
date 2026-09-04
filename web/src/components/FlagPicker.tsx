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
 * A tag select rather than a plain list, because a list is for discovering and
 * a text field is for saying. Two hundred and fifty-six flags will not fit in
 * anybody's head, and the twenty that matter still need values typed after
 * them; picking one writes it in, and anything unlisted can be typed whole.
 */

import { useEffect, useMemo, useState } from 'react';
import { Select, Typography } from 'antd';
import { fetchFlags, type LaunchFlag } from '../api';
import { MONO } from '../theme';

const { Text } = Typography;

/**
 * Words to tags, keeping a flag and its value together.
 *
 * A flag followed by a word that does not itself start a flag is that flag's
 * value. Split into separate chips, deleting the flag would leave its value
 * behind as a bare word the program then chokes on.
 */
export function toTags(text: string): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const tags: string[] = [];
  for (let i = 0; i < words.length; i += 1) {
    const next = words[i + 1];
    if (words[i].startsWith('-') && next && !next.startsWith('-')) {
      tags.push(`${words[i]} ${next}`);
      i += 1;
    } else {
      tags.push(words[i]);
    }
  }
  return tags;
}

interface Props {
  /** Which program's flags: the model launcher, or one ComfyUI container. */
  source: { kind: 'llama-server' } | { kind: 'comfyui'; container: string };
  value?: string;
  onChange?: (value: string) => void;
  placeholder?: string;
  /** Written by the console itself and filtered out if typed, because two
   *  copies of the same switch would fight. */
  reserved?: string[];
}

export default function FlagPicker({
  source, value = '', onChange, placeholder, reserved = [],
}: Props) {
  const [flags, setFlags] = useState<LaunchFlag[]>([]);
  const key = source.kind === 'comfyui' ? source.container : 'llama-server';

  useEffect(() => {
    let live = true;
    fetchFlags(source).then((f) => { if (live) setFlags(f); }).catch(() => undefined);
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source.kind, key]);

  const options = useMemo(() => {
    const groups = new Map<string, { value: string; label: React.ReactNode }[]>();
    for (const flag of flags) {
      // The long name is what anybody reading the command later will recognise;
      // the short one is an alias for the same thing and would only crowd the
      // list.
      const name = flag.names.find((n) => n.startsWith('--')) ?? flag.names[0];
      if (!name || name === '--help' || reserved.includes(name)) continue;
      const label = (
        <span>
          <Text style={{ fontFamily: MONO, fontSize: 12 }}>{name}</Text>
          {flag.takes_value && <Text type="secondary" style={{ fontSize: 11 }}> N</Text>}
          {flag.help && (
            <Text type="secondary" style={{ fontSize: 11 }}>　{flag.help}</Text>
          )}
        </span>
      );
      const bucket = groups.get(flag.group) ?? [];
      // A flag that takes a value is inserted with a placeholder after it, so
      // what lands in the box is editable rather than a switch that will be
      // rejected for having no argument.
      bucket.push({ value: flag.takes_value ? `${name} ` : name, label });
      groups.set(flag.group, bucket);
    }
    return [...groups].map(([label, opts]) => ({ label: label || '其他', options: opts }));
  }, [flags, reserved]);

  return (
    <Select
      mode="tags"
      value={toTags(value)}
      onChange={(tags: string[]) => onChange?.(
        tags.filter((t) => !reserved.some((r) => t.startsWith(r))).join(' ').trim())}
      options={options}
      placeholder={placeholder ?? (flags.length
        ? `從 ${flags.length} 個旗標裡挑，或直接打字`
        : '直接打字')}
      style={{ width: '100%' }}
      optionFilterProp="value"
      tokenSeparators={[',']}
      notFoundContent={flags.length ? undefined : '讀不到這個程式的旗標，直接打字即可'}
    />
  );
}
