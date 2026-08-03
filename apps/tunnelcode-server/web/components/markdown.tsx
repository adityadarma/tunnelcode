/**
 * The small subset of Markdown an engine actually answers in.
 *
 * Everything is turned into elements rather than into markup: engine output is
 * untrusted input, so it must never become live HTML.
 */

interface MarkdownBlock {
  type: 'code' | 'paragraph' | 'heading' | 'list' | 'quote';
  lang?: string;
  code?: string;
  items?: string[];
  text?: string;
  level?: number;
}

export function parseInlineMarkdown(text: string): React.ReactNode[] {
  const tokens = text.split(/(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|[*_][^*_]+[*_])/g);

  return tokens.map((token, index) => {
    if (token.startsWith('`') && token.endsWith('`') && token.length > 1) {
      return (
        <code key={index} className="inline-code">
          {token.slice(1, -1)}
        </code>
      );
    }
    if (
      (token.startsWith('**') && token.endsWith('**') && token.length > 3) ||
      (token.startsWith('__') && token.endsWith('__') && token.length > 3)
    ) {
      return <strong key={index}>{token.slice(2, -2)}</strong>;
    }
    if (
      (token.startsWith('*') && token.endsWith('*') && token.length > 2) ||
      (token.startsWith('_') && token.endsWith('_') && token.length > 2)
    ) {
      return <em key={index}>{token.slice(1, -1)}</em>;
    }
    return token;
  });
}

function parseMarkdownBlocks(content: string): MarkdownBlock[] {
  const lines = content.split('\n');
  const blocks: MarkdownBlock[] = [];

  let inCode = false;
  let codeLang = '';
  let codeLines: string[] = [];
  let currentParagraphLines: string[] = [];

  const flushParagraph = (): void => {
    if (currentParagraphLines.length > 0) {
      blocks.push({
        type: 'paragraph',
        text: currentParagraphLines.join('\n'),
      });
      currentParagraphLines = [];
    }
  };

  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      if (inCode) {
        blocks.push({
          type: 'code',
          lang: codeLang,
          code: codeLines.join('\n'),
        });
        inCode = false;
        codeLang = '';
        codeLines = [];
      } else {
        flushParagraph();
        inCode = true;
        codeLang = line.trim().slice(3).trim();
        codeLines = [];
      }
      continue;
    }

    if (inCode) {
      codeLines.push(line);
      continue;
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch && headingMatch[1] !== undefined && headingMatch[2] !== undefined) {
      flushParagraph();
      blocks.push({
        type: 'heading',
        level: headingMatch[1].length,
        text: headingMatch[2],
      });
      continue;
    }

    const listMatch = line.match(/^(\*|-|\d+\.)\s+(.+)$/);
    if (listMatch && listMatch[2] !== undefined) {
      const itemText = listMatch[2];
      flushParagraph();
      const lastBlock = blocks[blocks.length - 1];
      if (lastBlock && lastBlock.type === 'list' && lastBlock.items) {
        lastBlock.items.push(itemText);
      } else {
        blocks.push({
          type: 'list',
          items: [itemText],
        });
      }
      continue;
    }

    if (line.startsWith('>')) {
      flushParagraph();
      blocks.push({
        type: 'quote',
        text: line.slice(1).trim(),
      });
      continue;
    }

    currentParagraphLines.push(line);
  }

  if (inCode) {
    blocks.push({
      type: 'code',
      lang: codeLang,
      code: codeLines.join('\n'),
    });
  }

  flushParagraph();
  return blocks;
}

export function renderFormattedContent(content: string): React.JSX.Element {
  const blocks = parseMarkdownBlocks(content);

  return (
    <>
      {blocks.map((block, index) => {
        if (block.type === 'code') {
          return (
            <div key={index} className="code-block-wrapper">
              {block.lang !== undefined && block.lang !== '' && (
                <div className="code-block-header">{block.lang}</div>
              )}
              <pre className="code-block">
                <code>{block.code}</code>
              </pre>
            </div>
          );
        }

        if (block.type === 'heading') {
          return <h3 key={index}>{parseInlineMarkdown(block.text ?? '')}</h3>;
        }

        if (block.type === 'list') {
          return (
            <ul key={index} className="markdown-list">
              {block.items?.map((item, itemIdx) => (
                <li key={itemIdx}>{parseInlineMarkdown(item)}</li>
              ))}
            </ul>
          );
        }

        if (block.type === 'quote') {
          return (
            <blockquote key={index} className="markdown-quote">
              {parseInlineMarkdown(block.text ?? '')}
            </blockquote>
          );
        }

        return <p key={index}>{parseInlineMarkdown(block.text ?? '')}</p>;
      })}
    </>
  );
}
