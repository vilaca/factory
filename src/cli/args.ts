import { readFileSync } from 'node:fs';
import chalk from 'chalk';

export interface CliArgs {
  model?: string;
  host?: string;
  provider?: string;
  token?: string;
  help?: boolean;
  version?: boolean;
  debug?: boolean;
  noLog?: boolean;
  /** Treat session-log failures as fatal — exit non-zero on log init failure
   *  or first write failure. For workloads where logs are auditable artifacts
   *  (CI, scripted runs) and silent loss is unacceptable. */
  strictLog?: boolean;
  plan?: boolean;
  autoCorrect?: boolean;
  bashDedup?: boolean;
  readCache?: boolean;
  lineCountHint?: boolean;
  subagents?: boolean;
  hooks?: boolean;
  noBashDedup?: boolean;
  noReadCache?: boolean;
  noLineCountHint?: boolean;
  noSubagents?: boolean;
  noHooks?: boolean;
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

/** Flags whose presence sets a boolean field on `CliArgs`. */
const BOOLEAN_FLAGS: Record<string, keyof CliArgs> = {
  '--help': 'help',
  '-h': 'help',
  '--version': 'version',
  '-V': 'version',
  '--debug': 'debug',
  '--no-log': 'noLog',
  '--strict-log': 'strictLog',
  '--plan': 'plan',
  '--auto-correct': 'autoCorrect',
  '--bash-dedup': 'bashDedup',
  '--no-bash-dedup': 'noBashDedup',
  '--read-cache': 'readCache',
  '--no-read-cache': 'noReadCache',
  '--line-count-hint': 'lineCountHint',
  '--no-line-count-hint': 'noLineCountHint',
  '--subagents': 'subagents',
  '--no-subagents': 'noSubagents',
  '--skills': 'skills',
  '--no-skills': 'noSkills',
  '--hooks': 'hooks',
  '--no-hooks': 'noHooks',
  '--no-clear': 'noClear',
  '--pick': 'pick',
  '--save-rotate': 'saveRotate',
  '--no-rotate': 'noRotate',
  '--no-rotate-keys': 'noRotateKeys',
  '--no-rotate-models': 'noRotateModels',
};

/** Flags whose value is the next argv entry (a string). */
const STRING_FLAGS: Record<string, keyof CliArgs> = {
  '--model': 'model',
  '-m': 'model',
  '--host': 'host',
  '--provider': 'provider',
  '-p': 'provider',
  '--token': 'token',
  '-t': 'token',
  '--rotate': 'rotate',
};

function parsePositiveSeconds(raw: string | undefined): number {
  const n = Number(raw);
  if (!isFinite(n) || n <= 0) {
    console.error(`Invalid value for --turn-timeout: must be a positive number of seconds`);
    process.exit(1);
  }
  return n;
}

export function parseArgs(args: string[]): CliArgs {
  const result: CliArgs = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;

    const boolKey = BOOLEAN_FLAGS[arg];
    if (boolKey) {
      (result as Record<string, unknown>)[boolKey] = true;
      continue;
    }

    const strKey = STRING_FLAGS[arg];
    if (strKey) {
      (result as Record<string, unknown>)[strKey] = args[++i];
      continue;
    }

    if (arg === '--turn-timeout') {
      result.turnTimeoutSec = parsePositiveSeconds(args[++i]);
      continue;
    }

    if (!arg.startsWith('-')) {
      result.model = arg;
    }
  }

  return result;
}

function readPackageVersion(): string {
  try {
    const url = new URL('../../package.json', import.meta.url);
    const json = JSON.parse(readFileSync(url, 'utf8')) as { version?: string };
    return json.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

export function printVersion(): void {
  console.log(`factory ${readPackageVersion()}`);
}

export function printUsage(): void {
  const lines = [
    '',
    chalk.bold('  factory') +
      ' ' +
      chalk.dim(`v${readPackageVersion()}`) +
      chalk.dim(
        ' — Claude Code-like CLI for Ollama, HuggingFace, llama.cpp, Anthropic, Copilot, OpenRouter, Vercel AI Gateway, OpenCode Zen, Google AI Studio, Mistral, Codestral, Cerebras, Groq, Cohere & Workers AI',
      ),
    '',
    chalk.bold('  Usage:'),
    '    factory [options] [model]',
    '',
    chalk.bold('  Options:'),
    '    --model, -m <name>       Model to use',
    '    --provider, -p <name>    Provider: ollama (default), huggingface / hf, llamacpp, anthropic, copilot, openrouter, vercel, opencodezen, googleaistudio, mistral, codestral, cerebras, groq, cohere, openai, or workersai',
    '    --host <url>             Server host (default varies by provider)',
    '    --token, -t <token>      API token (HF_TOKEN, HUGGING_FACE_HUB_TOKEN, ANTHROPIC_API_KEY, OPENROUTER_API_KEY, AI_GATEWAY_API_KEY, VERCEL_OIDC_TOKEN, OPENCODE_ZEN_API_KEY, OPENCODE_API_KEY, GEMINI_API_KEY, GOOGLE_API_KEY, MISTRAL_API_KEY, CODESTRAL_API_KEY, CEREBRAS_API_KEY, GROQ_API_KEY, COHERE_API_KEY, OPENAI_API_KEY, CLOUDFLARE_API_TOKEN, GITHUB_COPILOT_API_KEY, or COPILOT_API_KEY env vars also work; Google AI Studio also supports OAuth via ADC)',
    '    --no-log                 Disable session logging to ~/.factory/sessions/',
    '    --strict-log             Exit non-zero if session logging fails (init or first write)',
    '    --plan                   Start in plan mode (writes are queued for approval)',
    '    --auto-correct           Enable LLM tool-call corrector (off by default)',
    '    --bash-dedup             Enable Bash near-duplicate detector (off by default)',
    '    --no-hooks               Disable user-supplied lifecycle shell hooks (on by default)',
    '    --no-read-cache          Disable Read mtime/hash cache (on by default)',
    '    --no-line-count-hint     Drop the cloc/scc system-prompt hint (on by default)',
    '    --no-subagents           Disable the Delegate tool (on by default)',
    '    --no-skills              Disable loading of .factory/skills/*.md (on by default)',
    '    --turn-timeout <sec>     Auto-abort the agent after N seconds per user prompt (default: off)',
    '    --no-clear               Do not clear the screen on startup',
    '    --pick                   Force the startup picker even when a previous session is on file',
    '    --rotate <a:b,c:d>       Default rotation chain (comma-separated <provider>:<model> entries; session-only unless --save-rotate)',
    '    --save-rotate            Persist --rotate to global config',
    '    --no-rotate              Disable both key rotation and model rotation',
    '    --no-rotate-keys         Disable key rotation (still rotate (provider, model) entries)',
    '    --no-rotate-models       Disable model rotation (still rotate keys within the same model)',
    '    --help, -h               Show this help',
    '    --version, -V            Print version and exit',
    '    --debug                  Enable debug logging to stderr (alias for FACTORY_DEBUG=1)',
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
    '    factory -p openai -m gpt-5',
    '    factory -p workersai -m @cf/qwen/qwen2.5-coder-32b-instruct',
    '    factory -p llamacpp --host http://localhost:8080',
    '    factory --host http://remote:11434',
    '',
  ];
  console.log(lines.join('\n'));
}
