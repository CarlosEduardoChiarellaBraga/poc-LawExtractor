// Prepare a legal doc for RAG consumption
//
// Converts an Akoma Ntoso XML into RAG-ready TextUnits.
//
// Output shape per unit:
//   id, type, eId, normId, ancestorIds, headingBreadcrumb, hierarchyDepth,
//   text (embedding-ready, context-prefixed), rawText, metadata?, versionInfo?, references?


interface NormMetadata {
  urn: string;
  number: string;
  names: Record<string, string>;
  shortForms: Record<string, string>;
  dateDocument: string;
  dateEntryInForce: string;
  dateApplicability: string;
  country: string;
  language: string;
  authoritative: boolean;
}

export interface TextUnit {
  id: string;
  type: "metadata" | "container" | "article" | "paragraph" | "item";
  eId: string;
  normId: string;
  ancestorIds: string[];
  headingBreadcrumb: string;
  hierarchyDepth: number;
  text: string;
  rawText: string;
  metadata?: NormMetadata;
  versionInfo?: string[];
  references?: string[];
}

interface HierNode {
  eId: string;
  tag: string;
  num: string;
  heading: string;
  isMarginal: boolean;
  rawXml: string;
  children: HierNode[];
  articles: RawArticle[];
}

interface RawArticle {
  eId: string;
  num: string;
  heading: string;
  subheading: string;
  versionNotes: string[];
  references: string[];
  rawXml: string;
}

interface RawParagraph {
  eId: string;
  num: string;
  ownText: string;
  items: RawItem[];
}

interface RawItem {
  eId: string;
  num: string;
  text: string;
}

// Strip all XML markup from a string, removing footnotes and superscripts first.
function stripTags(xml: string): string {
  return xml
    .replace(/<authorialNote[\s\S]*?<\/authorialNote>/gi, "")
    .replace(/<sup[\s\S]*?<\/sup>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractFirst(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return m ? stripTags(m[1]) : "";
}

function extractVersionNotes(xml: string): string[] {
  const notes: string[] = [];
  const re = /<authorialNote[\s\S]*?>([\s\S]*?)<\/authorialNote>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const t = stripTags(m[1]).trim();
    if (t) notes.push(t);
  }
  return notes;
}

function extractRefs(xml: string): string[] {
  const refs = new Set<string>();
  let m: RegExpExecArray | null;
  const hrefRe = /href="([^"#][^"]*)"/g;
  const rsRe = /fedlex:rs-uri="([^"]+)"/g;
  while ((m = hrefRe.exec(xml)) !== null) refs.add(m[1]);
  while ((m = rsRe.exec(xml)) !== null) refs.add(m[1]);
  return [...refs];
}

function extractMetadata(xml: string): NormMetadata {
  const attr = (tag: string, a: string) =>
    xml.match(new RegExp(`<${tag}[^>]*\\s${a}="([^"]*)"`, "i"))?.[1] ?? "";

  const dateAttr = (name: string) =>
    xml.match(new RegExp(`<FRBRdate\\s[^>]*date="([^"]*)"[^>]*name="${name}"`, "i"))?.[1] ?? "";

  const names: Record<string, string> = {};
  const shortForms: Record<string, string> = {};
  const nameRe = /<FRBRname\s[^>]*xml:lang="([^"]*)"[^>]*value="([^"]*)"(?:[^>]*shortForm="([^"]*)")?/gi;
  let m: RegExpExecArray | null;
  while ((m = nameRe.exec(xml)) !== null) {
    names[m[1]] = m[2];
    if (m[3]) shortForms[m[1]] = m[3];
  }

  return {
    urn: attr("FRBRthis", "value"),
    number: attr("FRBRnumber", "value"),
    names,
    shortForms,
    dateDocument: dateAttr("jolux:dateDocument"),
    dateEntryInForce: dateAttr("jolux:dateEntryInForce"),
    dateApplicability: dateAttr("jolux:dateApplicability"),
    country: attr("FRBRcountry", "value"),
    language: attr("FRBRlanguage", "language"),
    authoritative: attr("FRBRauthoritative", "value") === "true",
  };
}

// Walk xml and find all balanced <tag>…</tag> spans at the top level (not nested).
// Returns attrs, innerXml, fullXml, and the start position in xml.
function findBalancedBlocks(xml: string, tag: string) {
  const results: { attrs: string; innerXml: string; fullXml: string; startIdx: number }[] = [];
  const openRe = new RegExp(`<${tag}((?:\\s[^>]*)?)>`, "gi");
  const closeTag = `</${tag}>`;
  const openTag = `<${tag}`;

  let m: RegExpExecArray | null;
  while ((m = openRe.exec(xml)) !== null) {
    const blockStart = m.index;
    const attrs = m[1] ?? "";
    let depth = 1;
    let pos = m.index + m[0].length;
    const innerStart = pos;

    while (pos < xml.length && depth > 0) {
      const nextOpen = xml.indexOf(openTag, pos);
      const nextClose = xml.indexOf(closeTag, pos);
      if (nextClose === -1) break;
      if (nextOpen !== -1 && nextOpen < nextClose) {
        depth++;
        pos = nextOpen + openTag.length;
      } else {
        depth--;
        pos = depth > 0 ? nextClose + closeTag.length : nextClose;
      }
    }

    if (depth === 0) {
      const innerXml = xml.slice(innerStart, pos);
      const fullXml = xml.slice(blockStart, pos + closeTag.length);
      results.push({ attrs, innerXml, fullXml, startIdx: blockStart });
      openRe.lastIndex = pos + closeTag.length;
    }
  }
  return results;
}

const CONTAINER_TAGS = [
  "book", "part", "title", "chapter", "subchapter",
  "section", "level", "hcontainer",
];

// Find direct (non-nested) container elements within xml.
function findDirectContainers(xml: string) {
  const all: {
    tag: string; eId: string; isMarginal: boolean;
    num: string; heading: string;
    innerXml: string; fullXml: string; startIdx: number;
  }[] = [];

  for (const tag of CONTAINER_TAGS) {
    for (const b of findBalancedBlocks(xml, tag)) {
      const eIdM = b.attrs.match(/eId="([^"]*)"/);
      if (!eIdM) continue;
      all.push({
        tag,
        eId: eIdM[1],
        isMarginal: /fedlex:role="marginal"/.test(b.attrs),
        num: extractFirst(b.innerXml, "num"),
        heading: extractFirst(b.innerXml, "heading"),
        ...b,
      });
    }
  }

  all.sort((a, b) => a.startIdx - b.startIdx);

  // Discard anything fully contained within an earlier block.
  const top: typeof all = [];
  const ranges: [number, number][] = [];
  for (const item of all) {
    const end = item.startIdx + item.fullXml.length;
    if (!ranges.some(([s, e]) => item.startIdx >= s && end <= e)) {
      top.push(item);
      ranges.push([item.startIdx, end]);
    }
  }
  return top;
}

// Find <article> elements that are NOT inside any container block.
function findDirectArticles(xml: string): RawArticle[] {
  // Blank out container blocks so nested articles are invisible.
  let stripped = xml;
  for (const tag of CONTAINER_TAGS) {
    for (const b of findBalancedBlocks(xml, tag).sort((a, b_) => b_.startIdx - a.startIdx)) {
      stripped =
        stripped.slice(0, b.startIdx) +
        " ".repeat(b.fullXml.length) +
        stripped.slice(b.startIdx + b.fullXml.length);
    }
  }

  const articles: RawArticle[] = [];
  for (const b of findBalancedBlocks(stripped, "article")) {
    const eIdM = b.attrs.match(/eId="([^"]*)"/);
    if (!eIdM) continue;
    // Pull the original XML back using the eId to avoid reading blanked-out text.
    const orig = xml.match(
      new RegExp(`<article[^>]*eId="${eIdM[1]}"[\\s\\S]*?<\\/article>`, "i")
    );
    if (!orig) continue;
    const inner = orig[0].slice(orig[0].indexOf(">") + 1, orig[0].lastIndexOf("</article>"));
    articles.push({
      eId: eIdM[1],
      num: extractFirst(inner, "num"),
      heading: extractFirst(inner, "heading"),
      subheading: extractFirst(inner, "subheading"),
      versionNotes: extractVersionNotes(inner),
      references: extractRefs(inner),
      rawXml: orig[0],
    });
  }
  return articles;
}

function extractParagraphs(articleXml: string): RawParagraph[] {
  return findBalancedBlocks(articleXml, "paragraph").flatMap((b) => {
    const eIdM = b.attrs.match(/eId="([^"]*)"/);
    if (!eIdM) return [];
    const items = findBalancedBlocks(b.innerXml, "item").flatMap((ib) => {
      const iEIdM = ib.attrs.match(/eId="([^"]*)"/);
      if (!iEIdM) return [];
      return [{ eId: iEIdM[1], num: extractFirst(ib.innerXml, "num"), text: stripTags(ib.innerXml) }];
    });
    const listIntro = extractFirst(b.innerXml, "listIntroduction");
    const ownText = (
      listIntro ||
      stripTags(
        b.innerXml
          .replace(/<item[\s\S]*?<\/item>/gi, "")
          .replace(/<num[^>]*>[\s\S]*?<\/num>/gi, "")
      )
    ).replace(/\s+/g, " ").trim();
    return [{ eId: eIdM[1], num: extractFirst(b.innerXml, "num"), ownText, items }];
  });
}

function buildTree(xml: string): HierNode[] {
  return findDirectContainers(xml).map((c) => ({
    eId: c.eId,
    tag: c.tag,
    num: c.num,
    heading: c.heading,
    isMarginal: c.isMarginal,
    rawXml: c.fullXml,
    children: buildTree(c.innerXml),
    articles: findDirectArticles(c.innerXml),
  }));
}

function nodeLabel(node: HierNode): string {
  const num = node.num.trim();
  const head = node.heading.trim();
  if (num && head) return `${num} ${head}`;
  return num || head || node.eId;
}

function pushContainerUnit(node: HierNode, normId: string, ancestors: HierNode[], out: TextUnit[]) {
  const label = nodeLabel(node);
  const breadcrumb = [...ancestors.map(nodeLabel), label].join(" > ");
  out.push({
    id: `${normId}!${node.eId}`,
    type: "container",
    eId: node.eId,
    normId,
    ancestorIds: ancestors.map((a) => a.eId),
    headingBreadcrumb: breadcrumb,
    hierarchyDepth: ancestors.length + 1,
    text: breadcrumb,
    rawText: label,
  });
}

function pushArticleUnits(art: RawArticle, normId: string, ancestors: HierNode[], out: TextUnit[]) {
  const artLabel = [art.num.trim(), art.heading].filter(Boolean).join(" – ");
  const breadcrumb = [...ancestors.map(nodeLabel), artLabel].join(" > ");
  const ancestorIds = ancestors.map((a) => a.eId);
  const depth = ancestors.length + 1;

  const paragraphs = extractParagraphs(art.rawXml);
  const bodyText = paragraphs
    .map((p) => {
      const label = p.num ? `Abs. ${p.num}: ` : "";
      const itemText = p.items.map((i) => `${i.num.trim()} ${i.text}`).join(" ");
      return label + p.ownText + (itemText ? " " + itemText : "");
    })
    .join("\n")
    .trim();

  const artPrefix = art.subheading
    ? `[${art.num.trim()} ${art.subheading}]`
    : `[${art.num.trim()}]`;

  out.push({
    id: `${normId}!${art.eId}`,
    type: "article",
    eId: art.eId,
    normId,
    ancestorIds,
    headingBreadcrumb: breadcrumb,
    hierarchyDepth: depth,
    text: bodyText ? `${artPrefix}\n${bodyText}` : artLabel,
    rawText: bodyText || artLabel,
    versionInfo: art.versionNotes.length ? art.versionNotes : undefined,
    references: art.references.length ? art.references : undefined,
  });

  for (const para of paragraphs) {
    const paraLabel = para.num ? `Abs. ${para.num}` : "";
    const paraBreadcrumb = paraLabel ? `${breadcrumb} > ${paraLabel}` : breadcrumb;
    const artCtx = `${art.num.trim()}${art.heading ? " – " + art.heading : ""}`;
    const paraCumText = para.num
      ? `[${artCtx}, Abs. ${para.num}] ${para.ownText}`
      : `[${artCtx}] ${para.ownText}`;

    out.push({
      id: `${normId}!${para.eId}`,
      type: "paragraph",
      eId: para.eId,
      normId,
      ancestorIds: [...ancestorIds, art.eId],
      headingBreadcrumb: paraBreadcrumb,
      hierarchyDepth: depth + 1,
      text: paraCumText,
      rawText: para.ownText,
    });

    for (const item of para.items) {
      const itemNum = item.num.trim();
      out.push({
        id: `${normId}!${item.eId}`,
        type: "item",
        eId: item.eId,
        normId,
        ancestorIds: [...ancestorIds, art.eId, para.eId],
        headingBreadcrumb: `${paraBreadcrumb} > ${itemNum}`,
        hierarchyDepth: depth + 2,
        text: `[${artCtx}${para.num ? ", Abs. " + para.num : ""}: ${para.ownText}] ${itemNum} ${item.text}`,
        rawText: item.text,
      });
    }
  }
}

function walkTree(nodes: HierNode[], normId: string, ancestors: HierNode[], out: TextUnit[]) {
  for (const node of nodes) {
    pushContainerUnit(node, normId, ancestors, out);
    for (const art of node.articles) {
      pushArticleUnits(art, normId, [...ancestors, node], out);
    }
    walkTree(node.children, normId, [...ancestors, node], out);
  }
}

function extractTextUnits(xml: string): TextUnit[] {
  const out: TextUnit[] = [];

  const metaXml = xml.match(/<meta>([\s\S]*?)<\/meta>/i)?.[0] ?? "";
  const meta = extractMetadata(metaXml);
  const preamble = (() => {
    const m = xml.match(/<preamble>([\s\S]*?)<\/preamble>/i);
    return m ? stripTags(m[1]) : "";
  })();

  const nameDisplay =
    meta.names["de"] || meta.names["en"] || Object.values(meta.names)[0] || "Unknown Norm";
  const shortForm = meta.shortForms["de"] || meta.shortForms["en"] || "";

  const metaText = [
    `Norm: ${nameDisplay}${shortForm ? ` (${shortForm})` : ""}`,
    `Number: ${meta.number}`,
    `Country: ${meta.country}`,
    `Language: ${meta.language}`,
    `Date of document: ${meta.dateDocument}`,
    `Entry into force: ${meta.dateEntryInForce}`,
    `Applicable version: ${meta.dateApplicability}`,
    `URN: ${meta.urn}`,
    `Authoritative: ${meta.authoritative}`,
    preamble ? `Preamble: ${preamble}` : "",
  ].filter(Boolean).join("\n");

  out.push({
    id: `norm:${meta.number}`,
    type: "metadata",
    eId: "norm",
    normId: meta.number,
    ancestorIds: [],
    headingBreadcrumb: nameDisplay,
    hierarchyDepth: 0,
    text: metaText,
    rawText: metaText,
    metadata: meta,
  });

  const bodyXml = xml.match(/<body>([\s\S]*?)<\/body>/i)?.[1];
  if (!bodyXml) return out;

  const tree = buildTree(bodyXml);
  if (tree.length > 0) {
    walkTree(tree, meta.number, [], out);
  } else {
    for (const art of findDirectArticles(bodyXml)) {
      pushArticleUnits(art, meta.number, [], out);
    }
  }

  return out;
}

export function convertLegalXmlToJson(xml: string): TextUnit[] {
  return extractTextUnits(xml);
}