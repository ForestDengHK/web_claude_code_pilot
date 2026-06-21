/**
 * POC live runner for the OpenAI (GPT-5.5) backend.
 *
 * Proves the end-to-end path against the real Responses API. Purely additive —
 * not wired into the app. Requires OPENAI_API_KEY in the environment.
 *
 *   OPENAI_API_KEY=sk-... node --import tsx scripts/poc-openai-chat.ts "Plan a refactor of X"
 *   OPENAI_API_KEY=sk-... node --import tsx scripts/poc-openai-chat.ts --model gpt-5.5-pro --effort high "..."
 *
 * It prints the SSE event sequence exactly as the frontend would receive it,
 * plus a reassembled transcript, so you can eyeball that the mapping is faithful.
 */

import { streamOpenAI } from '../src/lib/openai-client';

function parseArgs(argv: string[]) {
  let model = 'gpt-5.5';
  let effort: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--model') model = argv[++i];
    else if (argv[i] === '--effort') effort = argv[++i];
    else rest.push(argv[i]);
  }
  return { model, effort, prompt: rest.join(' ') };
}

async function main() {
  const { model, effort, prompt } = parseArgs(process.argv.slice(2));
  if (!prompt) {
    console.error('usage: node --import tsx scripts/poc-openai-chat.ts [--model m] [--effort e] "<prompt>"');
    process.exit(1);
  }
  if (!process.env.OPENAI_API_KEY) {
    console.error('error: OPENAI_API_KEY is not set');
    process.exit(1);
  }

  console.error(`> model=${model}${effort ? ` effort=${effort}` : ''}\n`);

  const stream = streamOpenAI({ prompt, model, effort });
  const reader = stream.getReader();
  let buf = '';
  let transcript = '';
  let reasoning = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let sep: number;
    while ((sep = buf.indexOf('\n\n')) !== -1) {
      const line = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      if (!line.startsWith('data:')) continue;
      const e = JSON.parse(line.slice('data:'.length).trim()) as { type: string; data: string };
      console.error(`[sse] ${e.type}${e.data ? ` ${e.data.slice(0, 80)}` : ''}`);
      if (e.type === 'text') transcript += e.data;
      if (e.type === 'thinking') reasoning += e.data;
    }
  }

  if (reasoning) console.log(`\n--- reasoning ---\n${reasoning}`);
  console.log(`\n--- answer ---\n${transcript}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
