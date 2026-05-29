import { useEffect, useMemo, useState } from 'react';
import {
  Archive,
  Clock3,
  Copy,
  FileText,
  Folder,
  Hash,
  Library,
  PanelRight,
  Plus,
  Search,
  Settings,
  Sparkles,
  Star,
  Tags,
  WandSparkles,
} from 'lucide-react';
import { formatCaDateLong } from '../lib/ca-time';
import './PromptLibrary.css';

type PromptItem = {
  id: string;
  title: string;
  body: string;
  library: string;
  tags: string[];
  favorite: boolean;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  uses: number;
  variables: Array<{ name: string; value: string }>;
  history: Array<{ at: string; context: string }>;
};

type SortMode = 'recent' | 'updated' | 'title';
type ViewMode = 'all' | 'favorites' | 'recent';
type EngineerMode = 'general' | 'content' | 'coding' | 'business' | 'support';
type DetailLevel = 'focused' | 'detailed' | 'expert';

const STORAGE_KEY = 'prompt-library:items:v1';

const engineerModes: Array<{ value: EngineerMode; label: string; role: string; output: string }> = [
  {
    value: 'general',
    label: 'General',
    role: 'senior prompt engineer and execution partner',
    output: 'a clear answer with practical structure',
  },
  {
    value: 'content',
    label: 'Content',
    role: 'content strategist and editor',
    output: 'publishable copy with examples and options',
  },
  {
    value: 'coding',
    label: 'Coding',
    role: 'senior software engineer',
    output: 'implementation steps, code, verification notes, and risks',
  },
  {
    value: 'business',
    label: 'Business',
    role: 'operator and strategy analyst',
    output: 'a decision-ready plan with tradeoffs and next actions',
  },
  {
    value: 'support',
    label: 'Support',
    role: 'customer support lead',
    output: 'a helpful response that is accurate, calm, and specific',
  },
];

const detailLevels: Record<DetailLevel, { label: string; guidance: string }> = {
  focused: {
    label: 'Focused',
    guidance: 'Keep the response concise, but include the details needed to act.',
  },
  detailed: {
    label: 'Detailed',
    guidance: 'Expand the work with examples, assumptions, edge cases, and concrete steps.',
  },
  expert: {
    label: 'Expert',
    guidance: 'Go deep: include reasoning, risks, tradeoffs, validation checks, and a polished final structure.',
  },
};

const seedPrompts: PromptItem[] = [
  {
    id: 'prompt-email-first-touch',
    title: 'Email Outreach - First Touch',
    body:
      'You are a helpful email assistant.\n\nWrite a short, friendly cold email to a potential customer introducing our product.\n\nTone: professional, warm, and concise.\nInclude a clear value proposition and a call to action.\nKeep it under 120 words.',
    library: 'Marketing',
    tags: ['Email', 'Outreach'],
    favorite: true,
    createdAt: '2024-04-18T09:00:00.000Z',
    updatedAt: '2024-04-24T14:30:00.000Z',
    lastUsedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    uses: 18,
    variables: [
      { name: 'company_name', value: 'Acme Inc.' },
      { name: 'product_name', value: 'Product X' },
      { name: 'value_prop', value: 'helps teams save time' },
    ],
    history: [
      { at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), context: 'Used in Outreach Campaign - Q2' },
      { at: new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString(), context: 'Used in New Leads Follow Up' },
      { at: '2024-04-22T11:00:00.000Z', context: 'Used in Partnership Outreach' },
    ],
  },
  {
    id: 'prompt-blog-outline',
    title: 'Blog Post Outline - How To',
    body:
      'Create a practical blog post outline for a how-to article. Include a strong intro, 5 to 7 main sections, examples, and a concise conclusion.',
    library: 'Marketing',
    tags: ['Blog', 'SEO'],
    favorite: true,
    createdAt: '2024-04-17T10:00:00.000Z',
    updatedAt: '2024-04-23T13:15:00.000Z',
    lastUsedAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    uses: 12,
    variables: [{ name: 'topic', value: 'remote onboarding' }],
    history: [{ at: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(), context: 'Used in Content Calendar' }],
  },
  {
    id: 'prompt-product-summary',
    title: 'Product Feature Summary',
    body:
      'Summarize a product feature for a release note. Explain what changed, why it matters, and how a customer can start using it.',
    library: 'Product',
    tags: ['Product', 'Launch'],
    favorite: true,
    createdAt: '2024-04-16T08:20:00.000Z',
    updatedAt: '2024-04-21T15:40:00.000Z',
    lastUsedAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
    uses: 9,
    variables: [{ name: 'feature_name', value: 'Team Inbox' }],
    history: [{ at: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(), context: 'Used in Release Notes' }],
  },
  {
    id: 'prompt-bug-report',
    title: 'Bug Report Assistant',
    body:
      'Turn rough notes into a clear engineering bug report with expected behavior, actual behavior, reproduction steps, impact, and open questions.',
    library: 'Engineering',
    tags: ['Engineering'],
    favorite: false,
    createdAt: '2024-04-15T10:45:00.000Z',
    updatedAt: '2024-04-20T17:10:00.000Z',
    lastUsedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
    uses: 7,
    variables: [{ name: 'affected_area', value: 'Billing settings' }],
    history: [{ at: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(), context: 'Used in Issue Triage' }],
  },
  {
    id: 'prompt-customer-support',
    title: 'Customer Support Reply',
    body:
      'Draft a support reply that acknowledges the issue, explains the next step, and keeps the customer confident without overpromising.',
    library: 'Customer Support',
    tags: ['Support', 'Email'],
    favorite: true,
    createdAt: '2024-04-14T09:30:00.000Z',
    updatedAt: '2024-04-19T12:15:00.000Z',
    lastUsedAt: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString(),
    uses: 14,
    variables: [{ name: 'customer_name', value: 'Jordan' }],
    history: [{ at: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString(), context: 'Used in Support Queue' }],
  },
  {
    id: 'prompt-social-launch',
    title: 'Social Media Post - Launch',
    body:
      'Write three social launch posts for LinkedIn and X. Each version should be crisp, benefit-focused, and end with a natural call to action.',
    library: 'Marketing',
    tags: ['Social Media', 'Launch'],
    favorite: false,
    createdAt: '2024-04-13T16:00:00.000Z',
    updatedAt: '2024-04-18T16:30:00.000Z',
    lastUsedAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
    uses: 6,
    variables: [{ name: 'launch_name', value: 'Smart Templates' }],
    history: [{ at: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(), context: 'Used in Launch Drafts' }],
  },
  {
    id: 'prompt-seo-meta',
    title: 'SEO Meta Description',
    body:
      'Write five meta descriptions under 155 characters. Make each clear, specific, and aligned with search intent.',
    library: 'Marketing',
    tags: ['SEO'],
    favorite: false,
    createdAt: '2024-04-12T11:30:00.000Z',
    updatedAt: '2024-04-17T10:10:00.000Z',
    lastUsedAt: new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString(),
    uses: 11,
    variables: [{ name: 'page_topic', value: 'Prompt workflows' }],
    history: [{ at: new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString(), context: 'Used in SEO Sprint' }],
  },
  {
    id: 'prompt-meeting-summary',
    title: 'Meeting Notes Summary',
    body:
      'Summarize meeting notes into decisions, action items, owners, due dates, and unresolved questions.',
    library: 'Personal',
    tags: ['Productivity'],
    favorite: true,
    createdAt: '2024-04-10T10:15:00.000Z',
    updatedAt: '2024-04-16T09:00:00.000Z',
    lastUsedAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
    uses: 20,
    variables: [{ name: 'meeting_name', value: 'Weekly planning' }],
    history: [{ at: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(), context: 'Used in Leadership Sync' }],
  },
];

function loadPrompts() {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (!stored) return seedPrompts;
    const parsed = JSON.parse(stored);
    return Array.isArray(parsed) && parsed.length ? (parsed as PromptItem[]) : seedPrompts;
  } catch {
    return seedPrompts;
  }
}

function relativeTime(value: string | null) {
  if (!value) return 'Never';
  const delta = Date.now() - new Date(value).getTime();
  const minutes = Math.max(1, Math.floor(delta / 60000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

function formatDate(value: string | null) {
  if (!value) return 'Never';
  return formatCaDateLong(value);
}

function splitTags(value: string) {
  return value
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function countBy<T extends string>(values: T[]) {
  return values.reduce<Record<string, number>>((acc, item) => {
    acc[item] = (acc[item] ?? 0) + 1;
    return acc;
  }, {});
}

function compactText(value: string) {
  return value.trim().replace(/\n{3,}/g, '\n\n');
}

function extractVariablesFromText(value: string) {
  const matches = Array.from(value.matchAll(/\{\{\s*([a-zA-Z0-9_-]+)\s*\}\}/g), (match) => match[1]?.trim() ?? '');
  return Array.from(new Set(matches))
    .filter(Boolean)
    .map((name) => ({ name, value: '' }));
}

function buildEngineeredPrompt(input: string, mode: EngineerMode, detailLevel: DetailLevel, tone: string, audience: string) {
  const source = compactText(input);
  const modeConfig = engineerModes.find((item) => item.value === mode) ?? engineerModes[0]!;
  const detailConfig = detailLevels[detailLevel];
  const targetAudience = audience.trim() || 'the intended reader';
  const targetTone = tone.trim() || 'clear, specific, and practical';

  return compactText(`Role:
You are a ${modeConfig.role}.

Objective:
${source}

Audience:
${targetAudience}

Tone:
${targetTone}

Context To Preserve:
- Keep the user's original intent intact.
- Make assumptions visible when important information is missing.
- Ask clarifying questions only when the missing detail would materially change the output.

Instructions:
1. Restate the goal in concrete terms before doing the work.
2. Use specific details, examples, and constraints instead of generic advice.
3. Break complex work into clear sections or steps.
4. Include any relevant edge cases, risks, dependencies, or decision points.
5. ${detailConfig.guidance}
6. Do not invent facts. Mark unknowns clearly and suggest what information is needed.

Output Format:
Return ${modeConfig.output}.
Use headings, short paragraphs, and bullets only where they improve readability.

Quality Bar:
- The result should be immediately usable.
- The result should be more detailed than the original request without adding noise.
- Include a final checklist or next action when useful.`);
}

function makePrompt(): PromptItem {
  const now = new Date().toISOString();
  return {
    id: `prompt-${Date.now()}`,
    title: 'Untitled Prompt',
    body: 'Write your reusable prompt here.',
    library: 'Personal',
    tags: ['Draft'],
    favorite: false,
    createdAt: now,
    updatedAt: now,
    lastUsedAt: null,
    uses: 0,
    variables: [{ name: 'input', value: 'Example value' }],
    history: [],
  };
}

export default function PromptLibrary() {
  const [prompts, setPrompts] = useState<PromptItem[]>(loadPrompts);
  const [selectedId, setSelectedId] = useState(prompts[0]?.id ?? '');
  const [query, setQuery] = useState('');
  const [viewMode, setViewMode] = useState<ViewMode>('all');
  const [activeLibrary, setActiveLibrary] = useState<string>('All Prompts');
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [sortMode, setSortMode] = useState<SortMode>('recent');
  const [copied, setCopied] = useState(false);
  const [engineerInput, setEngineerInput] = useState('');
  const [engineerMode, setEngineerMode] = useState<EngineerMode>('general');
  const [engineerDetail, setEngineerDetail] = useState<DetailLevel>('detailed');
  const [engineerTone, setEngineerTone] = useState('Clear, practical, specific');
  const [engineerAudience, setEngineerAudience] = useState('A capable teammate');
  const [engineeredPrompt, setEngineeredPrompt] = useState('');
  const [engineerCopied, setEngineerCopied] = useState(false);

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prompts));
  }, [prompts]);

  const libraries = useMemo(() => {
    const counts = countBy(prompts.map((prompt) => prompt.library));
    return Object.entries(counts).sort(([a], [b]) => a.localeCompare(b));
  }, [prompts]);

  const tags = useMemo(() => {
    const counts = countBy(prompts.flatMap((prompt) => prompt.tags));
    return Object.entries(counts).sort(([, a], [, b]) => b - a);
  }, [prompts]);

  const selectedPrompt = prompts.find((prompt) => prompt.id === selectedId) ?? prompts[0] ?? null;

  useEffect(() => {
    if (!selectedPrompt || engineerInput.trim()) return;
    setEngineerInput(selectedPrompt.body);
  }, [engineerInput, selectedPrompt]);

  const filteredPrompts = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return prompts
      .filter((prompt) => {
        const matchesView =
          viewMode === 'all' ||
          (viewMode === 'favorites' && prompt.favorite) ||
          (viewMode === 'recent' && prompt.lastUsedAt);
        const matchesLibrary = activeLibrary === 'All Prompts' || prompt.library === activeLibrary;
        const matchesTag = !activeTag || prompt.tags.includes(activeTag);
        const haystack = [prompt.title, prompt.body, prompt.library, ...prompt.tags].join(' ').toLowerCase();
        return matchesView && matchesLibrary && matchesTag && (!normalizedQuery || haystack.includes(normalizedQuery));
      })
      .sort((a, b) => {
        if (sortMode === 'title') return a.title.localeCompare(b.title);
        const aDate = sortMode === 'updated' ? a.updatedAt : a.lastUsedAt ?? a.updatedAt;
        const bDate = sortMode === 'updated' ? b.updatedAt : b.lastUsedAt ?? b.updatedAt;
        return new Date(bDate).getTime() - new Date(aDate).getTime();
      });
  }, [activeLibrary, activeTag, prompts, query, sortMode, viewMode]);

  useEffect(() => {
    if (!filteredPrompts.length) return;
    if (!filteredPrompts.some((prompt) => prompt.id === selectedId)) {
      setSelectedId(filteredPrompts[0]!.id);
    }
  }, [filteredPrompts, selectedId]);

  const updatePrompt = (id: string, patch: Partial<PromptItem>) => {
    setPrompts((current) =>
      current.map((prompt) =>
        prompt.id === id
          ? {
              ...prompt,
              ...patch,
              updatedAt: patch.updatedAt ?? new Date().toISOString(),
            }
          : prompt,
      ),
    );
  };

  const createPrompt = () => {
    const nextPrompt = makePrompt();
    setPrompts((current) => [nextPrompt, ...current]);
    setSelectedId(nextPrompt.id);
    setViewMode('all');
    setActiveLibrary('All Prompts');
    setActiveTag(null);
  };

  const usePrompt = async () => {
    if (!selectedPrompt) return;
    const now = new Date().toISOString();
    const nextHistory = [{ at: now, context: 'Copied from Prompt Library' }, ...selectedPrompt.history].slice(0, 5);
    updatePrompt(selectedPrompt.id, {
      lastUsedAt: now,
      uses: selectedPrompt.uses + 1,
      history: nextHistory,
      updatedAt: selectedPrompt.updatedAt,
    });
    try {
      await navigator.clipboard?.writeText(selectedPrompt.body);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  const loadSelectedIntoEngineer = () => {
    if (!selectedPrompt) return;
    setEngineerInput(selectedPrompt.body);
    setEngineeredPrompt('');
  };

  const generateEngineeredPrompt = () => {
    const source = engineerInput.trim() || selectedPrompt?.body.trim() || '';
    if (!source) return;
    setEngineeredPrompt(buildEngineeredPrompt(source, engineerMode, engineerDetail, engineerTone, engineerAudience));
  };

  const copyEngineeredPrompt = async () => {
    if (!engineeredPrompt.trim()) return;
    try {
      await navigator.clipboard?.writeText(engineeredPrompt);
      setEngineerCopied(true);
      window.setTimeout(() => setEngineerCopied(false), 1500);
    } catch {
      setEngineerCopied(false);
    }
  };

  const replaceWithEngineeredPrompt = () => {
    if (!selectedPrompt || !engineeredPrompt.trim()) return;
    updatePrompt(selectedPrompt.id, {
      body: engineeredPrompt,
      variables: extractVariablesFromText(engineeredPrompt),
    });
  };

  const saveEngineeredPrompt = () => {
    if (!engineeredPrompt.trim()) return;
    const now = new Date().toISOString();
    const sourcePrompt = selectedPrompt;
    const variables = extractVariablesFromText(engineeredPrompt);
    const nextPrompt: PromptItem = {
      id: `prompt-${Date.now()}-engineered`,
      title: `${sourcePrompt?.title ?? 'Detailed Prompt'} - Engineered`,
      body: engineeredPrompt,
      library: sourcePrompt?.library ?? 'Personal',
      tags: Array.from(new Set([...(sourcePrompt?.tags ?? []), 'Engineered'])),
      favorite: false,
      createdAt: now,
      updatedAt: now,
      lastUsedAt: null,
      uses: 0,
      variables: variables.length ? variables : (sourcePrompt?.variables ?? []),
      history: [{ at: now, context: 'Created with Prompt Engineer' }],
    };

    setPrompts((current) => [nextPrompt, ...current]);
    setSelectedId(nextPrompt.id);
    setViewMode('all');
    setActiveLibrary('All Prompts');
    setActiveTag(null);
  };

  const resetFilters = () => {
    setViewMode('all');
    setActiveLibrary('All Prompts');
    setActiveTag(null);
    setQuery('');
  };

  return (
    <div className="prompt-shell">
      <aside className="prompt-sidebar">
        <div className="prompt-brand">
          <div className="prompt-brand-mark">
            <Sparkles size={15} />
          </div>
          <span>Prompt Library</span>
        </div>

        <button className="prompt-new-button" type="button" onClick={createPrompt}>
          <Plus size={14} />
          New Prompt
        </button>

        <nav className="prompt-nav" aria-label="Prompt views">
          <button
            className={viewMode === 'all' && activeLibrary === 'All Prompts' && !activeTag ? 'is-active' : ''}
            type="button"
            onClick={resetFilters}
          >
            <Library size={14} />
            <span>All Prompts</span>
            <strong>{prompts.length}</strong>
          </button>
          <button
            className={viewMode === 'favorites' ? 'is-active' : ''}
            type="button"
            onClick={() => {
              setViewMode('favorites');
              setActiveLibrary('All Prompts');
              setActiveTag(null);
            }}
          >
            <Star size={14} />
            <span>Favorites</span>
            <strong>{prompts.filter((prompt) => prompt.favorite).length}</strong>
          </button>
          <button
            className={viewMode === 'recent' ? 'is-active' : ''}
            type="button"
            onClick={() => {
              setViewMode('recent');
              setActiveLibrary('All Prompts');
              setActiveTag(null);
            }}
          >
            <Clock3 size={14} />
            <span>Recents</span>
            <strong>{prompts.filter((prompt) => prompt.lastUsedAt).length}</strong>
          </button>
        </nav>

        <div className="prompt-sidebar-section">
          <div className="prompt-section-label">
            <span>Libraries</span>
          </div>
          {libraries.map(([libraryName, count]) => (
            <button
              className={activeLibrary === libraryName ? 'is-active' : ''}
              key={libraryName}
              type="button"
              onClick={() => {
                setActiveLibrary(libraryName);
                setViewMode('all');
                setActiveTag(null);
              }}
            >
              <Folder size={14} />
              <span>{libraryName}</span>
              <strong>{count}</strong>
            </button>
          ))}
        </div>

        <div className="prompt-sidebar-section">
          <div className="prompt-section-label">
            <span>Tags</span>
          </div>
          {tags.slice(0, 8).map(([tag, count]) => (
            <button
              className={activeTag === tag ? 'is-active' : ''}
              key={tag}
              type="button"
              onClick={() => {
                setActiveTag(tag);
                setViewMode('all');
                setActiveLibrary('All Prompts');
              }}
            >
              <Hash size={14} />
              <span>{tag}</span>
              <strong>{count}</strong>
            </button>
          ))}
        </div>

        <div className="prompt-sidebar-footer">
          <button type="button">
            <Settings size={14} />
            <span>Settings</span>
          </button>
          <div className="prompt-user">
            <div>AC</div>
            <span>Alex Chen</span>
          </div>
        </div>
      </aside>

      <main className="prompt-main">
        <section className="prompt-list-pane">
          <header className="prompt-list-header">
            <div>
              <p>{activeTag ? `Tag / ${activeTag}` : viewMode === 'favorites' ? 'Favorites' : viewMode === 'recent' ? 'Recents' : activeLibrary}</p>
              <h1>{filteredPrompts.length} prompts</h1>
            </div>
            <button className="prompt-icon-button" type="button" onClick={createPrompt} aria-label="Create prompt">
              <Plus size={16} />
            </button>
          </header>

          <div className="prompt-toolbar">
            <label className="prompt-search">
              <Search size={15} />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search prompts, tags, libraries..."
              />
            </label>
            <select value={sortMode} onChange={(event) => setSortMode(event.target.value as SortMode)} aria-label="Sort prompts">
              <option value="recent">Last used</option>
              <option value="updated">Updated</option>
              <option value="title">Title</option>
            </select>
          </div>

          <div className="prompt-list">
            {filteredPrompts.map((prompt) => (
              <button
                className={`prompt-row ${prompt.id === selectedPrompt?.id ? 'is-selected' : ''}`}
                key={prompt.id}
                type="button"
                onClick={() => setSelectedId(prompt.id)}
              >
                <div className="prompt-row-icon">
                  <FileText size={14} />
                </div>
                <div className="prompt-row-body">
                  <div className="prompt-row-title">
                    <span>{prompt.title}</span>
                    {prompt.favorite ? <Star className="is-filled" size={13} /> : null}
                  </div>
                  <p>{prompt.body}</p>
                  <div className="prompt-row-meta">
                    {prompt.tags.slice(0, 2).map((tag) => (
                      <span key={tag}>{tag}</span>
                    ))}
                    <em>{relativeTime(prompt.lastUsedAt ?? prompt.updatedAt)}</em>
                  </div>
                </div>
              </button>
            ))}
          </div>
        </section>

        <section className="prompt-detail-pane">
          {selectedPrompt ? (
            <>
              <header className="prompt-detail-header">
                <div className="prompt-title-block">
                  <input
                    value={selectedPrompt.title}
                    onChange={(event) => updatePrompt(selectedPrompt.id, { title: event.target.value })}
                    aria-label="Prompt title"
                  />
                  <div className="prompt-chip-row">
                    <span>{selectedPrompt.library}</span>
                    {selectedPrompt.tags.map((tag) => (
                      <span key={tag}>{tag}</span>
                    ))}
                  </div>
                </div>
                <div className="prompt-detail-actions">
                  <button
                    className={`prompt-icon-button ${selectedPrompt.favorite ? 'is-favorite' : ''}`}
                    type="button"
                    onClick={() => updatePrompt(selectedPrompt.id, { favorite: !selectedPrompt.favorite })}
                    aria-label="Toggle favorite"
                  >
                    <Star size={16} />
                  </button>
                  <button className="prompt-action-button" type="button" onClick={usePrompt}>
                    <Copy size={14} />
                    {copied ? 'Copied' : 'Use Prompt'}
                  </button>
                </div>
              </header>

              <div className="prompt-stats">
                <div>
                  <span>Created</span>
                  <strong>{formatDate(selectedPrompt.createdAt)}</strong>
                </div>
                <div>
                  <span>Last used</span>
                  <strong>{relativeTime(selectedPrompt.lastUsedAt)}</strong>
                </div>
                <div>
                  <span>Updated</span>
                  <strong>{formatDate(selectedPrompt.updatedAt)}</strong>
                </div>
                <div>
                  <span>Uses</span>
                  <strong>{selectedPrompt.uses}</strong>
                </div>
              </div>

              <section className="prompt-engineer" aria-label="Prompt engineer">
                <div className="prompt-engineer-header">
                  <div className="prompt-engineer-title">
                    <WandSparkles size={15} />
                    <span>Prompt Engineer</span>
                  </div>
                  <div className="prompt-engineer-header-actions">
                    <button className="prompt-secondary-button" type="button" onClick={loadSelectedIntoEngineer}>
                      Use Current
                    </button>
                    <button className="prompt-primary-button" type="button" onClick={generateEngineeredPrompt}>
                      <WandSparkles size={14} />
                      Make Detailed
                    </button>
                  </div>
                </div>

                <div className="prompt-engineer-controls">
                  <label>
                    <span>Mode</span>
                    <select value={engineerMode} onChange={(event) => setEngineerMode(event.target.value as EngineerMode)}>
                      {engineerModes.map((mode) => (
                        <option key={mode.value} value={mode.value}>
                          {mode.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>Detail</span>
                    <select value={engineerDetail} onChange={(event) => setEngineerDetail(event.target.value as DetailLevel)}>
                      {Object.entries(detailLevels).map(([value, config]) => (
                        <option key={value} value={value}>
                          {config.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>Tone</span>
                    <input value={engineerTone} onChange={(event) => setEngineerTone(event.target.value)} />
                  </label>
                  <label>
                    <span>Audience</span>
                    <input value={engineerAudience} onChange={(event) => setEngineerAudience(event.target.value)} />
                  </label>
                </div>

                <div className="prompt-engineer-grid">
                  <label className="prompt-engineer-field">
                    <span>Rough Prompt</span>
                    <textarea
                      value={engineerInput}
                      onChange={(event) => setEngineerInput(event.target.value)}
                      placeholder="Paste a rough request or use the selected prompt."
                    />
                  </label>
                  <label className="prompt-engineer-field">
                    <span>Detailed Prompt</span>
                    <textarea
                      value={engineeredPrompt}
                      onChange={(event) => setEngineeredPrompt(event.target.value)}
                      placeholder="Generated prompt appears here."
                    />
                  </label>
                </div>

                <div className="prompt-engineer-footer">
                  <button className="prompt-secondary-button" type="button" onClick={copyEngineeredPrompt} disabled={!engineeredPrompt.trim()}>
                    <Copy size={14} />
                    {engineerCopied ? 'Copied' : 'Copy'}
                  </button>
                  <button
                    className="prompt-secondary-button"
                    type="button"
                    onClick={replaceWithEngineeredPrompt}
                    disabled={!engineeredPrompt.trim()}
                  >
                    Replace Prompt
                  </button>
                  <button className="prompt-secondary-button" type="button" onClick={saveEngineeredPrompt} disabled={!engineeredPrompt.trim()}>
                    <Plus size={14} />
                    Save New
                  </button>
                </div>
              </section>

              <div className="prompt-editor-grid">
                <section className="prompt-editor">
                  <div className="prompt-panel-heading">
                    <PanelRight size={14} />
                    <span>Prompt</span>
                  </div>
                  <textarea
                    value={selectedPrompt.body}
                    onChange={(event) => updatePrompt(selectedPrompt.id, { body: event.target.value })}
                    aria-label="Prompt body"
                  />
                </section>

                <aside className="prompt-properties">
                  <div className="prompt-panel-heading">
                    <Archive size={14} />
                    <span>Details</span>
                  </div>
                  <label>
                    Library
                    <input
                      value={selectedPrompt.library}
                      onChange={(event) => updatePrompt(selectedPrompt.id, { library: event.target.value || 'Personal' })}
                    />
                  </label>
                  <label>
                    Tags
                    <input
                      value={selectedPrompt.tags.join(', ')}
                      onChange={(event) => updatePrompt(selectedPrompt.id, { tags: splitTags(event.target.value) })}
                    />
                  </label>
                  <label>
                    Variables
                    <textarea
                      className="prompt-variables-input"
                      value={selectedPrompt.variables.map((variable) => `${variable.name}: ${variable.value}`).join('\n')}
                      onChange={(event) => {
                        const variables = event.target.value
                          .split('\n')
                          .map((line) => {
                            const [name, ...rest] = line.split(':');
                            return { name: name?.trim() ?? '', value: rest.join(':').trim() };
                          })
                          .filter((variable) => variable.name);
                        updatePrompt(selectedPrompt.id, { variables });
                      }}
                    />
                  </label>
                </aside>
              </div>

              <section className="prompt-bottom-grid">
                <div className="prompt-variable-table">
                  <div className="prompt-panel-heading">
                    <Tags size={14} />
                    <span>Variables</span>
                  </div>
                  {selectedPrompt.variables.length ? (
                    selectedPrompt.variables.map((variable) => (
                      <div className="prompt-variable-row" key={variable.name}>
                        <code>{`{{${variable.name}}}`}</code>
                        <span>{variable.value}</span>
                      </div>
                    ))
                  ) : (
                    <p className="prompt-muted">No variables saved</p>
                  )}
                </div>

                <div className="prompt-history">
                  <div className="prompt-panel-heading">
                    <Clock3 size={14} />
                    <span>Usage History</span>
                  </div>
                  {selectedPrompt.history.length ? (
                    selectedPrompt.history.map((entry) => (
                      <div className="prompt-history-row" key={`${entry.at}-${entry.context}`}>
                        <span>{relativeTime(entry.at)}</span>
                        <strong>{entry.context}</strong>
                      </div>
                    ))
                  ) : (
                    <p className="prompt-muted">No usage yet</p>
                  )}
                </div>
              </section>
            </>
          ) : (
            <div className="prompt-empty">
              <FileText size={26} />
              <span>No prompts found</span>
              <button type="button" onClick={createPrompt}>Create Prompt</button>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
