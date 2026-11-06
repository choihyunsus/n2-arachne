// Preserve offsets and newlines while hiding comments and quoted literals from heuristic matching.
const QUOTED = String.raw`"(?:\\[\s\S]|[^"\\\r\n])*"?|'(?:\\[\s\S]|[^'\\\r\n])*'?`;
const C_STYLE = String.raw`\/\*[\s\S]*?(?:\*\/|$)|\/\/[^\r\n]*|\x60(?:\\[\s\S]|[^\x60\\])*\x60?|${QUOTED}`;
const PYTHON = String.raw`#[^\r\n]*|"""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)|${QUOTED}`;
const JS_REGEXP = String.raw`(?<=[=(:,!?\[;])\s*\/(?:\\.|\[(?:\\.|[^\]\\])*\]|[^\/\\\r\n\[])+\/[dgimsuvy]*|(?<=\breturn)\s+\/(?:\\.|[^\/\\\r\n])+\/[dgimsuvy]*|`;

export function maskSource(content: string, language: string, commentsOnly = false): string {
  let expression = language === 'py' ? PYTHON : C_STYLE;
  if (language === 'js' || language === 'ts') expression = JS_REGEXP + expression;
  return content.replace(new RegExp(expression, 'g'), (match) => {
    if (
      commentsOnly &&
      !match.startsWith('//') &&
      !match.startsWith('/*') &&
      !(language === 'py' && match.startsWith('#'))
    )
      return match;
    return match.replace(/[^\r\n]/g, ' ');
  });
}
