import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Pencil, Trash2, Check, X } from 'lucide-react';
import Topbar from '../components/Topbar';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { api } from '../lib/api';

type Setting = { key: string; value: string | null };

export default function Settings() {
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.get<{ data: Setting[] }>('/settings'),
  });

  const upsert = useMutation({
    mutationFn: ({ key, value }: { key: string; value: string }) =>
      api.put<Setting>(`/settings/${encodeURIComponent(key)}`, { value }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['settings'] }),
  });

  const remove = useMutation({
    mutationFn: (key: string) => api.delete(`/settings/${encodeURIComponent(key)}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['settings'] }),
  });

  const rows = data?.data ?? [];

  const startEdit = (row: Setting) => {
    setEditingKey(row.key);
    setEditValue(row.value ?? '');
  };
  const cancelEdit = () => {
    setEditingKey(null);
    setEditValue('');
  };
  const saveEdit = (key: string) => {
    upsert.mutate(
      { key, value: editValue },
      { onSuccess: cancelEdit }
    );
  };

  const submitNew = (e: FormEvent) => {
    e.preventDefault();
    if (!newKey.trim()) return;
    upsert.mutate(
      { key: newKey.trim(), value: newValue },
      {
        onSuccess: () => {
          setAdding(false);
          setNewKey('');
          setNewValue('');
        },
      }
    );
  };

  return (
    <>
      <Topbar
        title="Settings"
        right={
          <Button
            variant="primary"
            size="sm"
            onClick={() => setAdding((v) => !v)}
          >
            <Plus size={12} />
            New setting
          </Button>
        }
      />

      <div className="flex-1 min-h-0 overflow-auto bg-white">
        {adding && (
          <form
            onSubmit={submitNew}
            className="px-4 py-3 border-b border-line bg-brand-bg flex items-end gap-2"
          >
            <div className="flex-1">
              <label className="section-label block mb-1">Key</label>
              <Input
                value={newKey}
                onChange={(e) => setNewKey(e.target.value)}
                placeholder="e.g. default_weight_oz"
                required
                autoFocus
              />
            </div>
            <div className="flex-[2]">
              <label className="section-label block mb-1">Value</label>
              <Input
                value={newValue}
                onChange={(e) => setNewValue(e.target.value)}
              />
            </div>
            <Button
              type="submit"
              variant="primary"
              size="md"
              disabled={upsert.isPending || !newKey.trim()}
            >
              {upsert.isPending ? 'Saving…' : 'Save'}
            </Button>
            <Button type="button" variant="ghost" size="md" onClick={() => setAdding(false)}>
              Cancel
            </Button>
          </form>
        )}

        <table className="w-full text-sm2 border-collapse">
          <thead className="sticky top-0 z-10 bg-surface-2">
            <tr>
              <Th className="w-[280px]">Key</Th>
              <Th>Value</Th>
              <Th className="w-[120px]" />
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr>
                <td colSpan={3} className="p-10 text-center text-ink-3">
                  Loading…
                </td>
              </tr>
            )}
            {!isLoading && rows.length === 0 && (
              <tr>
                <td colSpan={3} className="p-16 text-center text-ink-3">
                  <div className="text-4xl mb-2">⚙️</div>
                  <div className="font-semibold text-ink-2">No settings yet</div>
                  <div className="text-xs mt-1">
                    Add key-value pairs here to control app behavior.
                  </div>
                </td>
              </tr>
            )}
            {rows.map((row, i) => {
              const isEditing = editingKey === row.key;
              const isSystemKey =
                row.key.includes('.') || row.key.startsWith('order_sync');
              return (
                <tr
                  key={row.key}
                  className={`border-b border-line ${i % 2 === 1 ? 'bg-surface-2' : 'bg-white'}`}
                >
                  <td className="px-3 py-2 font-mono text-[12px] text-ink align-middle break-all">
                    {row.key}
                    {isSystemKey && (
                      <span className="ml-2 text-2xs font-bold text-ink-3 uppercase">
                        system
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 align-middle">
                    {isEditing ? (
                      <Input
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        autoFocus
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') saveEdit(row.key);
                          if (e.key === 'Escape') cancelEdit();
                        }}
                      />
                    ) : (
                      <span className="font-mono text-[12px] text-ink-2 break-all">
                        {row.value ?? <span className="text-ink-3">(empty)</span>}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 align-middle">
                    {isEditing ? (
                      <div className="flex items-center gap-1">
                        <Button
                          variant="primary"
                          size="xs"
                          onClick={() => saveEdit(row.key)}
                          disabled={upsert.isPending}
                        >
                          <Check size={11} />
                        </Button>
                        <Button variant="ghost" size="xs" onClick={cancelEdit}>
                          <X size={11} />
                        </Button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-1">
                        <Button variant="ghost" size="xs" onClick={() => startEdit(row)}>
                          <Pencil size={11} />
                        </Button>
                        <Button
                          variant="ghost"
                          size="xs"
                          onClick={() => {
                            if (confirm(`Delete setting "${row.key}"?`)) {
                              remove.mutate(row.key);
                            }
                          }}
                          className="text-ink-3 hover:!text-danger"
                          disabled={remove.isPending}
                        >
                          <Trash2 size={11} />
                        </Button>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Th({
  children,
  className = '',
}: {
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <th
      className={`text-left px-3 py-1.5 text-[10.5px] font-bold uppercase tracking-[0.4px] text-ink-3 border-b-2 border-line bg-surface-2 whitespace-nowrap ${className}`}
    >
      {children}
    </th>
  );
}
