// Direct test against Qwen API to see actual response
import { initAuth } from '../src/services/auth.ts';
import { accounts } from '../src/services/accountManager.ts';

console.log('Direct Qwen test starting...');

// Initialize auth — will load existing profile
await initAuth();

// Wait for the auth to load
for (let i = 0; i < 10; i++) {
  if (accounts.length > 0 && accounts[0].state?.token) break;
  await new Promise(resolve => setTimeout(resolve, 1000));
}

const acct = accounts[0];
if (!acct?.state?.token) {
  console.log('No auth token available');
  process.exit(1);
}

console.log('Using account:', acct.email);

// Try a direct chat request to Qwen — minimal payload
const response = await fetch('https://chat.qwen.ai/api/v2/chat/completions', {
  method: 'POST',
  headers: {
    'accept': 'application/json, text/plain, */*',
    'content-type': 'application/json',
    'source': 'web',
    'cookie': `token=${acct.state.token}`,
    'origin': 'https://chat.qwen.ai',
    'referer': 'https://chat.qwen.ai/',
    'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
  },
  body: JSON.stringify({
    stream: true,
    version: '2.1',
    incremental_output: true,
    chat_id: null,
    chat_mode: 'normal',
    model: 'qwen3.5-flash',
    parent_id: null,
    messages: [{
      fid: crypto.randomUUID(),
      parentId: null,
      childrenIds: [],
      role: 'user',
      content: 'Say hello',
      user_action: 'chat',
      files: [],
      timestamp: Math.floor(Date.now() / 1000),
      models: ['qwen3.5-flash'],
      chat_type: 't2t',
      feature_config: {
        thinking_enabled: true,
        output_schema: 'phase',
        research_mode: 'normal',
        auto_thinking: false,
        thinking_mode: 'Thinking',
        thinking_format: 'summary',
        auto_search: true,
      },
      extra: { meta: { subChatType: 't2t' } },
      sub_chat_type: 't2t',
      parent_id: null,
    }],
    timestamp: Math.floor(Date.now() / 1000) + 1,
  }),
});

console.log('Status:', response.status, response.statusText);
console.log('Headers:');
for (const [k, v] of response.headers.entries()) {
  console.log(`  ${k}: ${v}`);
}

const text = await response.text();
console.log('Body length:', text.length);
console.log('Body (first 3000 chars):');
console.log(text.substring(0, 3000));
console.log('---END---');
process.exit(0);
