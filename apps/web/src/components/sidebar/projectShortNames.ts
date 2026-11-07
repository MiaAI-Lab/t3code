// Below this a name fits a sidebar row as it is.
const SHORTEN_ABOVE_CHARS = 24;
const SEGMENT = /[^-_\s]+[-_\s]*/g;

const segmentsOf = (name: string): ReadonlyArray<string> => name.match(SEGMENT) ?? [name];
const bare = (segment: string) => segment.replace(/[-_\s]+$/, "");

function commonPrefixLength(lists: ReadonlyArray<ReadonlyArray<string>>): number {
  const shortest = Math.min(...lists.map((list) => list.length));
  let length = 0;
  while (
    length < shortest &&
    lists.every((list) => bare(list[length]!) === bare(lists[0]![length]!))
  ) {
    length++;
  }
  return length;
}

function commonSuffixLength(lists: ReadonlyArray<ReadonlyArray<string>>): number {
  const reversed = lists.map((list) => list.toReversed());
  return commonPrefixLength(reversed);
}

/**
 * Long project names that share a beginning keep only what tells them apart:
 * "GLM-5.3-Flash-EXL3-2x-DGX-Spark-TensorFold-Zig" beside "…-RTX-PRO-6000-TensorFold-Zig"
 * reads "GLM…DGX-Spark". A name with no similar sibling stays whole; the row truncates it.
 */
export function shortProjectNames(names: ReadonlyArray<string>): ReadonlyMap<string, string> {
  const unique = [...new Set(names)];
  const byFirst = new Map<string, string[]>();
  for (const name of unique) {
    const first = bare(segmentsOf(name)[0] ?? name).toLowerCase();
    byFirst.set(first, [...(byFirst.get(first) ?? []), name]);
  }
  const short = new Map<string, string>();
  for (const group of byFirst.values()) {
    const long = group.filter((name) => name.length > SHORTEN_ABOVE_CHARS);
    if (group.length < 2 || long.length === 0) continue;
    const lists = group.map(segmentsOf);
    const prefix = commonPrefixLength(lists);
    const suffix = commonSuffixLength(lists);
    for (const name of long) {
      const segments = segmentsOf(name);
      const middle = segments.slice(prefix, segments.length - suffix);
      // Nothing shared worth dropping, or nothing left to tell it apart.
      if (prefix < 2 || middle.length === 0) continue;
      short.set(name, `${bare(segments[0]!)}…${bare(middle.join(""))}`);
    }
  }
  return short;
}
