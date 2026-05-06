import chalk from 'chalk';

interface CliArgs {
  model?: string;
  host?: string;
  provider?: string;
  token?: string;
  help?: boolean;
  noLog?: boolean;
  plan?: boolean;
  noAutoCorrect?: boolean;
  bashDedup?: boolean;
  readCache?: boolean;
  lineCountHint?: boolean;
  subagents?: boolean;
  noBashDedup?: boolean;
  noReadCache?: boolean;
  noLineCountHint?: boolean;
  noSubagents?: boolean;
  skills?: boolean;
  noSkills?: boolean;
  turnTimeoutSec?: number;
  noClear?: boolean;
  pick?: boolean;
  /** Comma-separated `<provider>:<model>` entries for the rotation default
   *  chain. Session-only unless `--save-rotate` is also set. */
  rotate?: string;
  saveRotate?: boolean;
  noRotate?: boolean;
  noRotateKeys?: boolean;
  noRotateModels?: boolean;
}

export function parseArgs(args: string[]): CliArgs {
  const result: CliArgs = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--model' || arg === '-m') {
      result.model = args[++i];
    } else if (arg === '--host') {
      result.host = args[++i];
    } else if (arg === '--provider' || arg === '-p') {
      result.provider = args[++i];
    } else if (arg === '--token' || arg === '-t') {
      result.token = args[++i];
    } else if (arg === '--help' || arg === '-h') {
      result.help = true;
    } else if (arg === '--no-log') {
      result.noLog = true;
    } else if (arg === '--plan') {
      result.plan = true;
    } else if (arg === '--no-auto-correct') {
      result.noAutoCorrect = true;
    } else if (arg === '--bash-dedup') {
      result.bashDedup = true;
    } else if (arg === '--no-bash-dedup') {
      result.noBashDedup = true;
    } else if (arg === '--read-cache') {
      result.readCache = true;
    } else if (arg === '--no-read-cache') {
      result.noReadCache = true;
    } else if (arg === '--line-count-hint') {
      result.lineCountHint = true;
    } else if (arg === '--no-line-count-hint') {
      result.noLineCountHint = true;
    } else if (arg === '--subagents') {
      result.subagents = true;
    } else if (arg === '--no-subagents') {
      result.noSubagents = true;
    } else if (arg === '--skills') {
      result.skills = true;
    } else if (arg === '--no-skills') {
      result.noSkills = true;
    } else if (arg === '--no-clear') {
      result.noClear = true;
    } else if (arg === '--pick') {
      result.pick = true;
    } else if (arg === '--rotate') {
      result.rotate = args[++i];
    } else if (arg === '--save-rotate') {
      result.saveRotate = true;
    } else if (arg === '--no-rotate') {
      result.noRotate = true;
    } else if (arg === '--no-rotate-keys') {
      result.noRotateKeys = true;
    } else if (arg === '--no-rotate-models') {
      result.noRotateModels = true;
    } else if (arg === '--turn-timeout') {
      const n = Number(args[++i]);
      if (!isFinite(n) || n <= 0) {
        console.error(`Invalid value for --turn-timeout: must be a positive number of seconds`);
        process.exit(1);
      }
      result.turnTimeoutSec = n;
    } else if (!arg.startsWith('-')) {
      result.model = arg;
    }
  }

  return result;
}

export function printUsage(): void {
  const lines = [
    '',
    chalk.bold('  factory') + chalk.dim(' — Claude Code-like CLI for Ollama, HuggingFace, llama.cpp, Anthropic, Copilot, OpenRouter, Vercel AI Gateway, OpenCode Zen, Google AI Studio, Mistral, Codestral, Cerebras, Groq, Cohere & Workers AI'),
    '',
    chalk.bold('  Usage:'),
    '    factory [options] [model]',
    '',
    chalk.bold('  Options:'),
    '    --model, -m <name>       Model to use',
    '    --provider, -p <name>    Provider: ollama (default), huggingface / hf, llamacpp, anthropic, copilot, openrouter, vercel, opencodezen, googleaistudio, mistral, codestral, cerebras, groq, cohere, or workersai',
    '    --host <url>             Server host (default varies by provider)',
    '    --token, -t <token>      API token (HF_TOKEN, HUGGING_FACE_HUB_TOKEN, ANTHROPIC_API_KEY, OPENROUTER_API_KEY, AI_GATEWAY_API_KEY, VERCEL_OIDC_TOKEN, OPENCODE_ZEN_API_KEY, OPENCODE_API_KEY, GEMINI_API_KEY, GOOGLE_API_KEY, MISTRAL_API_KEY, CODESTRAL_API_KEY, CEREBRAS_API_KEY, GROQ_API_KEY, COHERE_API_KEY, CLOUDFLARE_API_TOKEN, GITHUB_COPILOT_API_KEY, or COPILOT_API_KEY env vars also work; Google AI Studio also supports OAuth via ADC)',
    '    --no-log                 Disable session logging to ~/.factory/sessions/',
    '    --plan                   Start in plan mode (writes are queued for approval)',
    '    --no-auto-correct        Disable LLM tool-call corrector (on by default)',
    '    --bash-dedup             Enable Bash near-duplicate detector (off by default)',
    '    --no-read-cache          Disable Read mtime/hash cache (on by default)',
    '    --no-line-count-hint     Drop the cloc/scc system-prompt hint (on by default)',
    '    --no-subagents           Disable the Delegate tool (on by default)',
    '    --skills                 Load .factory/skills/*.md and inject by trigger (off by default)',
    '    --turn-timeout <sec>     Auto-abort the agent after N seconds per user prompt (default: off)',
    '    --no-clear               Do not clear the screen on startup',
    '    --pick                   Force the startup picker even when a previous session is on file',
    '    --rotate <a:b,c:d>       Default rotation chain (comma-separated <provider>:<model> entries; session-only unless --save-rotate)',
    '    --save-rotate            Persist --rotate to global config',
    '    --no-rotate              Disable both key rotation and model rotation',
    '    --no-rotate-keys         Disable key rotation (still rotate (provider, model) entries)',
    '    --no-rotate-models       Disable model rotation (still rotate keys within the same model)',
    '    --help, -h               Show this help',
    '',
    chalk.bold('  Examples:'),
    '    factory qwen2.5-coder',
    '    factory --provider huggingface --model Qwen/Qwen2.5-Coder-32B-Instruct',
    '    factory -p anthropic -m claude-sonnet-4-6',
    '    factory -p copilot -m gpt-4.1',
    '    factory -p openrouter -m openai/gpt-4.1',
    '    factory -p vercel -m openai/gpt-5.4',
    '    factory -p opencodezen -m qwen3.6-plus',
    '    factory -p googleaistudio -m gemini-2.5-pro',
    '    factory -p mistral -m mistral-small-latest',
    '    factory -p codestral -m codestral-latest',
    '    factory -p cerebras -m gpt-oss-120b',
    '    factory -p groq -m llama-3.3-70b-versatile',
    '    factory -p cohere -m command-a-03-2025',
    '    factory -p workersai -m @cf/qwen/qwen2.5-coder-32b-instruct',
    '    factory -p llamacpp --host http://localhost:8080',
    '    factory --host http://remote:11434',
    '',
  ];
  console.log(lines.join('\n'));
}
