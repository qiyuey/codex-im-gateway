const OFFICIAL_NAMED_ENTITIES = new Map([
  ["amp", "&"],
  ["apos", "'"],
  ["gt", ">"],
  ["hellip", "…"],
  ["ldquo", "“"],
  ["lsquo", "‘"],
  ["lt", "<"],
  ["mdash", "—"],
  ["nbsp", "\u00a0"],
  ["ndash", "–"],
  ["quot", '"'],
  ["rdquo", "”"],
  ["rsquo", "’"],
]);

const SIMPLE_TAGS = new Set([
  "aside",
  "b",
  "blockquote",
  "br",
  "caption",
  "cite",
  "del",
  "em",
  "figcaption",
  "figure",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "i",
  "ins",
  "mark",
  "p",
  "pre",
  "s",
  "strike",
  "strong",
  "sub",
  "summary",
  "sup",
  "table",
  "td",
  "tg-collage",
  "tg-math",
  "tg-math-block",
  "tg-slideshow",
  "tg-spoiler",
  "th",
  "tr",
  "u",
  "ul",
]);

const VOID_TAGS = new Set(["br", "hr", "img", "input", "tg-map"]);
const DATE_TIME_FORMAT_PATTERN = /^(?:r|w?[dD]?[tT]?)$/;
const LANGUAGE_CLASS_PATTERN = /^language-[^\s"'<>]{1,64}$/u;
const INTEGER_PATTERN = /^-?\d+$/;
const UNSIGNED_INTEGER_PATTERN = /^\d+$/;

interface ParsedAttribute {
  readonly name: string;
  readonly value: string | null;
}

interface ParsedTag {
  readonly name: string;
  readonly closing: boolean;
  readonly selfClosing: boolean;
  readonly attributes: readonly ParsedAttribute[];
}

interface OpenTag {
  readonly name: string;
  readonly emitted: boolean;
}

export function sanitizeRichHtmlTags(value: string): string {
  let output = "";
  let cursor = 0;
  const openTags: OpenTag[] = [];

  while (cursor < value.length) {
    const start = value.indexOf("<", cursor);
    if (start < 0) {
      output += sanitizeTextEntities(value.slice(cursor));
      break;
    }

    output += sanitizeTextEntities(value.slice(cursor, start));
    if (isMarkdownEscaped(value, start)) {
      output += "<";
      cursor = start + 1;
      continue;
    }
    const end = findTagEnd(value, start);
    if (end < 0) {
      output += "&lt;";
      cursor = start + 1;
      continue;
    }

    const rawTag = value.slice(start, end + 1);
    const parsed = parseTag(rawTag);
    if (!parsed) {
      output += escapeRawTag(rawTag);
      cursor = end + 1;
      continue;
    }

    if (parsed.closing) {
      const open = openTags.at(-1);
      if (!open || open.name !== parsed.name || VOID_TAGS.has(parsed.name)) {
        output += escapeRawTag(rawTag);
      } else {
        openTags.pop();
        output += open.emitted ? `</${parsed.name}>` : escapeRawTag(rawTag);
      }
      cursor = end + 1;
      continue;
    }

    const suppressed = openTags.some((tag) => !tag.emitted);
    const sanitized = suppressed ? null : sanitizeStartTag(parsed);
    const emitted = sanitized !== null;
    output += sanitized ?? escapeRawTag(rawTag);

    if (!VOID_TAGS.has(parsed.name) && !parsed.selfClosing) {
      openTags.push({ name: parsed.name, emitted });
    }
    cursor = end + 1;
  }

  return output;
}

function isMarkdownEscaped(value: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

export function isSafeRichMarkdownDestination(value: string, media: boolean): boolean {
  const decoded = decodeHtmlEntities(value);
  if (media) return isSafeMediaUrl(decoded) || isSafeTelegramImageEntity(decoded);
  return isSafeInlineLink(decoded) || isSafeAnchorLink(decoded);
}

function findTagEnd(value: string, start: number): number {
  let quote: '"' | "'" | null = null;
  for (let index = start + 1; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === ">") return index;
  }
  return -1;
}

function parseTag(rawTag: string): ParsedTag | null {
  let body = rawTag.slice(1, -1).trim();
  if (!body || body.startsWith("!") || body.startsWith("?")) return null;

  const closing = body.startsWith("/");
  if (closing) body = body.slice(1).trimStart();
  const selfClosing = !closing && body.endsWith("/");
  if (selfClosing) body = body.slice(0, -1).trimEnd();

  const nameMatch = /^([A-Za-z][\w-]*)/.exec(body);
  if (!nameMatch) return null;
  const name = nameMatch[1]?.toLowerCase();
  if (!name) return null;
  const attributeSource = body.slice(nameMatch[0].length);
  const attributes = parseAttributes(attributeSource);
  if (!attributes || (closing && (attributes.length > 0 || selfClosing))) return null;
  return { name, closing, selfClosing, attributes };
}

function parseAttributes(source: string): readonly ParsedAttribute[] | null {
  const attributes: ParsedAttribute[] = [];
  const names = new Set<string>();
  let cursor = 0;

  while (cursor < source.length) {
    while (/\s/u.test(source[cursor] ?? "")) cursor += 1;
    if (cursor >= source.length) break;

    const nameMatch = /^[A-Za-z][\w-]*/.exec(source.slice(cursor));
    if (!nameMatch) return null;
    const name = nameMatch[0].toLowerCase();
    if (names.has(name)) return null;
    names.add(name);
    cursor += nameMatch[0].length;
    while (/\s/u.test(source[cursor] ?? "")) cursor += 1;

    if (source[cursor] !== "=") {
      attributes.push({ name, value: null });
      continue;
    }

    cursor += 1;
    while (/\s/u.test(source[cursor] ?? "")) cursor += 1;
    const quote = source[cursor];
    if (quote === '"' || quote === "'") {
      cursor += 1;
      const end = source.indexOf(quote, cursor);
      if (end < 0) return null;
      attributes.push({ name, value: decodeHtmlEntities(source.slice(cursor, end)) });
      cursor = end + 1;
      continue;
    }

    const valueMatch = /^[^\s"'`=<>]+/.exec(source.slice(cursor));
    if (!valueMatch) return null;
    attributes.push({ name, value: decodeHtmlEntities(valueMatch[0]) });
    cursor += valueMatch[0].length;
  }

  return attributes;
}

function sanitizeStartTag(tag: ParsedTag): string | null {
  if (tag.selfClosing && !VOID_TAGS.has(tag.name)) return null;
  if (SIMPLE_TAGS.has(tag.name)) {
    if (tag.name === "table")
      return serializeTag(tag.name, validateBooleanAttributes(tag, ["bordered", "striped"]));
    if (tag.name === "td" || tag.name === "th") return sanitizeTableCell(tag);
    return tag.attributes.length === 0 ? serializeTag(tag.name, []) : null;
  }

  switch (tag.name) {
    case "a":
      return sanitizeAnchor(tag);
    case "audio":
      return sanitizeMediaTag(tag, false);
    case "code":
      return sanitizeCode(tag);
    case "details":
      return serializeTag(tag.name, validateBooleanAttributes(tag, ["open"]));
    case "img":
      return sanitizeImage(tag);
    case "input":
      return sanitizeCheckbox(tag);
    case "li":
      return sanitizeListItem(tag);
    case "ol":
      return sanitizeOrderedList(tag);
    case "tg-emoji":
      return sanitizeCustomEmoji(tag);
    case "tg-map":
      return sanitizeMap(tag);
    case "tg-reference":
      return sanitizeNamedTag(tag);
    case "tg-time":
      return sanitizeDateTime(tag);
    case "video":
      return sanitizeMediaTag(tag, true);
    default:
      return null;
  }
}

function sanitizeAnchor(tag: ParsedTag): string | null {
  const attributes = attributeMap(tag);
  if (attributes?.size !== 1) return null;
  const href = attributes.get("href");
  if (href !== undefined && href !== null && (isSafeInlineLink(href) || isSafeAnchorLink(href))) {
    return serializeTag(tag.name, [["href", href]]);
  }
  const name = attributes.get("name");
  if (name !== undefined && name !== null && isSafeAnchorName(name)) {
    return serializeTag(tag.name, [["name", name]]);
  }
  return null;
}

function sanitizeCode(tag: ParsedTag): string | null {
  if (tag.attributes.length === 0) return serializeTag(tag.name, []);
  const attributes = attributeMap(tag);
  const language = attributes?.get("class");
  return attributes?.size === 1 && language && LANGUAGE_CLASS_PATTERN.test(language)
    ? serializeTag(tag.name, [["class", language]])
    : null;
}

function sanitizeNamedTag(tag: ParsedTag): string | null {
  const attributes = attributeMap(tag);
  const name = attributes?.get("name");
  return attributes?.size === 1 && name && isSafeAnchorName(name)
    ? serializeTag(tag.name, [["name", name]])
    : null;
}

function sanitizeCustomEmoji(tag: ParsedTag): string | null {
  const attributes = attributeMap(tag);
  const emojiId = attributes?.get("emoji-id");
  return attributes?.size === 1 && emojiId && UNSIGNED_INTEGER_PATTERN.test(emojiId)
    ? serializeTag(tag.name, [["emoji-id", emojiId]])
    : null;
}

function sanitizeDateTime(tag: ParsedTag): string | null {
  const attributes = attributeMap(tag);
  const unix = attributes?.get("unix");
  const format = attributes?.get("format");
  if (
    attributes?.size !== 2 ||
    unix === null ||
    unix === undefined ||
    format === null ||
    format === undefined ||
    !isValidUnixTime(unix) ||
    !DATE_TIME_FORMAT_PATTERN.test(format)
  ) {
    return null;
  }
  return serializeTag(tag.name, [
    ["unix", unix],
    ["format", format],
  ]);
}

function sanitizeOrderedList(tag: ParsedTag): string | null {
  const attributes = attributeMap(tag);
  if (!attributes) return null;
  const output: Array<readonly [string, string | null]> = [];
  for (const [name, value] of attributes) {
    if (name === "reversed" && isBooleanAttribute(name, value)) output.push([name, null]);
    else if (name === "start" && value !== null && isSafeInteger(value)) output.push([name, value]);
    else if (name === "type" && value !== null && isListType(value)) output.push([name, value]);
    else return null;
  }
  return serializeTag(tag.name, output);
}

function sanitizeListItem(tag: ParsedTag): string | null {
  const attributes = attributeMap(tag);
  if (!attributes) return null;
  const output: Array<readonly [string, string | null]> = [];
  for (const [name, value] of attributes) {
    if (name === "value" && value !== null && isSafeInteger(value)) output.push([name, value]);
    else if (name === "type" && value !== null && isListType(value)) output.push([name, value]);
    else return null;
  }
  return serializeTag(tag.name, output);
}

function sanitizeCheckbox(tag: ParsedTag): string | null {
  const attributes = attributeMap(tag);
  if (!attributes) return null;
  const type = attributes.get("type");
  if (type !== "checkbox") return null;
  const checked = attributes.get("checked");
  if (attributes.size > (checked === undefined ? 1 : 2)) return null;
  if (checked !== undefined && !isBooleanAttribute("checked", checked)) return null;
  return serializeTag(tag.name, [
    ["type", "checkbox"],
    ...(checked === undefined ? [] : [["checked", null] as const]),
  ]);
}

function sanitizeImage(tag: ParsedTag): string | null {
  const attributes = attributeMap(tag);
  if (!attributes) return null;
  const src = attributes.get("src");
  if (src === null || src === undefined || (!isSafeMediaUrl(src) && !isSafeTelegramEmojiUrl(src))) {
    return null;
  }
  const output: Array<readonly [string, string | null]> = [["src", src]];
  for (const [name, value] of attributes) {
    if (name === "src") continue;
    if (name === "alt" && value !== null && isSafeTelegramEmojiUrl(src) && value.length <= 64) {
      output.push([name, value]);
    } else if (name === "tg-spoiler" && isBooleanAttribute(name, value)) output.push([name, null]);
    else return null;
  }
  return serializeTag(tag.name, output);
}

function sanitizeMediaTag(tag: ParsedTag, supportsSpoiler: boolean): string | null {
  const attributes = attributeMap(tag);
  if (!attributes) return null;
  const src = attributes.get("src");
  if (src === null || src === undefined || !isSafeMediaUrl(src)) return null;
  const output: Array<readonly [string, string | null]> = [["src", src]];
  for (const [name, value] of attributes) {
    if (name === "src") continue;
    if (supportsSpoiler && name === "tg-spoiler" && isBooleanAttribute(name, value)) {
      output.push([name, null]);
    } else return null;
  }
  return serializeTag(tag.name, output);
}

function sanitizeMap(tag: ParsedTag): string | null {
  const attributes = attributeMap(tag);
  const lat = attributes?.get("lat");
  const long = attributes?.get("long");
  const zoom = attributes?.get("zoom");
  if (
    attributes?.size !== 3 ||
    lat === null ||
    lat === undefined ||
    long === null ||
    long === undefined ||
    zoom === null ||
    zoom === undefined ||
    !isNumberInRange(lat, -90, 90) ||
    !isNumberInRange(long, -180, 180) ||
    !UNSIGNED_INTEGER_PATTERN.test(zoom) ||
    Number(zoom) < 13 ||
    Number(zoom) > 20
  ) {
    return null;
  }
  return serializeTag(tag.name, [
    ["lat", lat],
    ["long", long],
    ["zoom", zoom],
  ]);
}

function sanitizeTableCell(tag: ParsedTag): string | null {
  const attributes = attributeMap(tag);
  if (!attributes) return null;
  const output: Array<readonly [string, string | null]> = [];
  for (const [name, value] of attributes) {
    if (
      (name === "colspan" || name === "rowspan") &&
      value !== null &&
      UNSIGNED_INTEGER_PATTERN.test(value) &&
      Number(value) >= 1 &&
      Number(value) <= 500
    ) {
      output.push([name, value]);
    } else if (name === "align" && value !== null && ["left", "center", "right"].includes(value)) {
      output.push([name, value]);
    } else if (name === "valign" && value !== null && ["top", "middle", "bottom"].includes(value)) {
      output.push([name, value]);
    } else return null;
  }
  return serializeTag(tag.name, output);
}

function validateBooleanAttributes(
  tag: ParsedTag,
  allowed: readonly string[],
): Array<readonly [string, null]> | null {
  const output: Array<readonly [string, null]> = [];
  for (const attribute of tag.attributes) {
    if (!allowed.includes(attribute.name) || !isBooleanAttribute(attribute.name, attribute.value)) {
      return null;
    }
    output.push([attribute.name, null]);
  }
  return output;
}

function attributeMap(tag: ParsedTag): ReadonlyMap<string, string | null> | null {
  const attributes = new Map<string, string | null>();
  for (const attribute of tag.attributes) {
    if (attributes.has(attribute.name)) return null;
    attributes.set(attribute.name, attribute.value);
  }
  return attributes;
}

function serializeTag(
  name: string,
  attributes: readonly (readonly [string, string | null])[] | null,
): string | null {
  if (!attributes) return null;
  const serialized = attributes
    .map(([attributeName, value]) =>
      value === null ? ` ${attributeName}` : ` ${attributeName}="${escapeAttribute(value)}"`,
    )
    .join("");
  return VOID_TAGS.has(name) ? `<${name}${serialized}/>` : `<${name}${serialized}>`;
}

function isSafeInlineLink(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === "http:" || url.protocol === "https:") return true;
    if (url.protocol === "mailto:") return url.pathname.length > 0 && !/\s/u.test(url.pathname);
    if (url.protocol === "tel:") return /^\+?[0-9(). -]+$/u.test(url.pathname);
    return /^tg:\/\/user\?id=\d+$/u.test(value);
  } catch {
    return false;
  }
}

function isSafeMediaUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function isSafeTelegramImageEntity(value: string): boolean {
  return isSafeTelegramEmojiUrl(value) || isSafeTelegramTimeUrl(value);
}

function isSafeTelegramEmojiUrl(value: string): boolean {
  return /^tg:\/\/emoji\?id=\d+$/u.test(value);
}

function isSafeTelegramTimeUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "tg:" || url.hostname !== "time") return false;
    const unix = url.searchParams.get("unix");
    const format = url.searchParams.get("format");
    return (
      url.searchParams.size === 2 &&
      unix !== null &&
      format !== null &&
      isValidUnixTime(unix) &&
      DATE_TIME_FORMAT_PATTERN.test(format)
    );
  } catch {
    return false;
  }
}

function isSafeAnchorLink(value: string): boolean {
  return value.startsWith("#") && isSafeAnchorName(value.slice(1));
}

function isSafeAnchorName(value: string): boolean {
  if (value.length < 1 || value.length > 128) return false;
  return !Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x20 || ['"', "'", "<", ">", "#"].includes(character);
  });
}

function isValidUnixTime(value: string): boolean {
  if (!UNSIGNED_INTEGER_PATTERN.test(value)) return false;
  const unix = Number(value);
  const latest = Math.floor(Date.now() / 1_000) + 1_098 * 86_400;
  return Number.isSafeInteger(unix) && unix <= latest;
}

function isSafeInteger(value: string): boolean {
  return INTEGER_PATTERN.test(value) && Number.isSafeInteger(Number(value));
}

function isListType(value: string): boolean {
  return ["1", "a", "A", "i", "I"].includes(value);
}

function isNumberInRange(value: string, minimum: number, maximum: number): boolean {
  if (!/^-?(?:\d+(?:\.\d+)?|\.\d+)$/u.test(value)) return false;
  const number = Number(value);
  return Number.isFinite(number) && number >= minimum && number <= maximum;
}

function isBooleanAttribute(name: string, value: string | null): boolean {
  return value === null || value === "" || value.toLowerCase() === name;
}

function decodeHtmlEntities(value: string): string {
  return value.replace(/&(?:#(\d+)|#x([\da-f]+)|([a-z]+));/giu, (match, decimal, hex, named) => {
    const codePoint = decimal ? Number(decimal) : hex ? Number.parseInt(hex, 16) : null;
    if (codePoint !== null) {
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return match;
      }
    }
    return OFFICIAL_NAMED_ENTITIES.get(String(named).toLowerCase()) ?? match;
  });
}

function sanitizeTextEntities(value: string): string {
  return value.replace(/&([A-Za-z][A-Za-z0-9]+);/g, (_match, name: string) => {
    const canonicalName = name.toLowerCase();
    return OFFICIAL_NAMED_ENTITIES.has(canonicalName) ? `&${canonicalName};` : `&amp;${name};`;
  });
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeRawTag(value: string): string {
  return value.replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
