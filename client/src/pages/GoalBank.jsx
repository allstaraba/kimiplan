import React, { useState, useEffect } from 'react';
import { getGoalBank, createGoalBankItem, updateGoalBankItem, deleteGoalBankItem } from '../api.js';

const DOMAINS = ['Communication', 'Social', 'Adaptive', 'Behavior Reduction', 'Caregiver Training'];
const DOMAIN_COLORS = {
  Communication: '#dbeafe',
  Social: '#dcfce7',
  Adaptive: '#fef3c7',
  'Behavior Reduction': '#fee2e2',
  'Caregiver Training': '#f3e8ff',
};

export default function GoalBank() {
  const [goals, setGoals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('All');
  const [search, setSearch] = useState('');

  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({ domain: 'Communication', goal_text: '', baseline_template: '', is_ferb: false });
  const [saving, setSaving] = useState(false);

  const load = () => {
    setLoading(true);
    getGoalBank()
      .then(data => { setGoals(data); setError(''); })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const filtered = goals.filter(g => {
    const matchesDomain = filter === 'All' || g.domain === filter;
    const q = search.toLowerCase();
    const matchesSearch = !q || g.goal_text.toLowerCase().includes(q) || g.baseline_template.toLowerCase().includes(q);
    return matchesDomain && matchesSearch;
  });

  const handleSave = async () => {
    if (!form.goal_text.trim()) return;
    setSaving(true);
    try {
      if (editing) {
        await updateGoalBankItem(editing.id, form.domain, form.goal_text, form.baseline_template, form.is_ferb);
      } else {
        await createGoalBankItem(form.domain, form.goal_text, form.baseline_template, form.is_ferb);
      }
      setForm({ domain: 'Communication', goal_text: '', baseline_template: '', is_ferb: false });
      setEditing(null);
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleEdit = (g) => {
    setEditing(g);
    setForm({ domain: g.domain, goal_text: g.goal_text, baseline_template: g.baseline_template || '', is_ferb: !!g.is_ferb });
  };

  const handleDelete = async (id) => {
    if (!window.confirm('Delete this goal from the bank?')) return;
    try {
      await deleteGoalBankItem(id);
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleCancel = () => {
    setEditing(null);
    setForm({ domain: 'Communication', goal_text: '', baseline_template: '', is_ferb: false });
  };

  return (
    <div style={{ padding: '28px 32px', maxWidth: '1100px', margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px' }}>
        <div>
          <h1 style={{ margin: 0, fontSize: '20px', fontWeight: '700', color: '#0f172a' }}>Goal Bank</h1>
          <p style={{ margin: '4px 0 0', fontSize: '13px', color: '#64748b' }}>
            Curated, clinically sound goals written by BCBAs. Attach these to treatment plans instead of using AI-generated goals.
          </p>
        </div>
        <div style={{ fontSize: '13px', color: '#64748b', fontWeight: '500' }}>
          {goals.length} goal{goals.length !== 1 ? 's' : ''}
        </div>
      </div>

      {error && (
        <div style={{ padding: '10px 14px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: '8px', color: '#dc2626', fontSize: '13px', marginBottom: '16px' }}>
          {error}
        </div>
      )}

      {/* Filters */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '20px', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
          {['All', ...DOMAINS].map(d => (
            <button
              key={d}
              onClick={() => setFilter(d)}
              style={{
                padding: '5px 12px',
                borderRadius: '16px',
                border: filter === d ? '2px solid #2563eb' : '1.5px solid #e2e8f0',
                background: filter === d ? '#eff6ff' : '#fff',
                color: filter === d ? '#2563eb' : '#64748b',
                fontSize: '12px',
                fontWeight: '600',
                cursor: 'pointer',
              }}
            >
              {d}
            </button>
          ))}
        </div>
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search goals..."
          style={{ padding: '6px 12px', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '13px', minWidth: '200px', outline: 'none' }}
        />
      </div>

      {/* Create / Edit Form */}
      <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '10px', padding: '16px 20px', marginBottom: '24px' }}>
        <div style={{ fontWeight: '600', fontSize: '14px', color: '#0f172a', marginBottom: '12px' }}>
          {editing ? 'Edit Goal' : 'Add New Goal'}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
            <select
              value={form.domain}
              onChange={e => setForm(prev => ({ ...prev, domain: e.target.value }))}
              style={{ padding: '7px 11px', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '13px', minWidth: '180px' }}
            >
              {DOMAINS.map(d => <option key={d} value={d}>{d}</option>)}
            </select>
            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', color: '#374151', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={form.is_ferb}
                onChange={e => setForm(prev => ({ ...prev, is_ferb: e.target.checked }))}
              />
              FERB (90% mastery)
            </label>
          </div>
          <textarea
            value={form.goal_text}
            onChange={e => setForm(prev => ({ ...prev, goal_text: e.target.value }))}
            placeholder="Goal statement..."
            rows={3}
            style={{ padding: '8px 11px', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '13px', resize: 'vertical', outline: 'none', fontFamily: 'inherit' }}
          />
          <textarea
            value={form.baseline_template}
            onChange={e => setForm(prev => ({ ...prev, baseline_template: e.target.value }))}
            placeholder="Baseline template (optional)..."
            rows={2}
            style={{ padding: '8px 11px', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '13px', resize: 'vertical', outline: 'none', fontFamily: 'inherit' }}
          />
          <div style={{ display: 'flex', gap: '10px' }}>
            <button
              onClick={handleSave}
              disabled={saving || !form.goal_text.trim()}
              style={{
                padding: '7px 18px',
                background: saving || !form.goal_text.trim() ? '#93c5fd' : '#2563eb',
                border: 'none',
                borderRadius: '6px',
                color: '#fff',
                fontSize: '13px',
                fontWeight: '600',
                cursor: saving || !form.goal_text.trim() ? 'not-allowed' : 'pointer',
              }}
            >
              {saving ? 'Saving…' : (editing ? 'Update Goal' : 'Add to Bank')}
            </button>
            {editing && (
              <button
                onClick={handleCancel}
                style={{ padding: '7px 18px', background: '#f1f5f9', border: '1px solid #e2e8f0', borderRadius: '6px', color: '#64748b', fontSize: '13px', fontWeight: '600', cursor: 'pointer' }}
              >
                Cancel
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Goals List */}
      {loading ? (
        <div style={{ color: '#94a3b8', fontSize: '14px' }}>Loading goals…</div>
      ) : filtered.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '40px', color: '#94a3b8', fontSize: '14px' }}>
          {search || filter !== 'All' ? 'No goals match your filters.' : 'No goals in the bank yet. Add your first goal above.'}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {filtered.map(g => (
            <div
              key={g.id}
              style={{
                background: '#fff',
                border: '1px solid #e2e8f0',
                borderRadius: '8px',
                padding: '14px 18px',
                borderLeft: `4px solid ${DOMAIN_COLORS[g.domain] || '#e2e8f0'}`,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px' }}>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
                    <span style={{
                      fontSize: '11px',
                      fontWeight: '700',
                      textTransform: 'uppercase',
                      letterSpacing: '0.03em',
                      padding: '2px 8px',
                      borderRadius: '4px',
                      background: DOMAIN_COLORS[g.domain] || '#f1f5f9',
                      color: '#374151',
                    }}>
                      {g.domain}
                    </span>
                    {g.is_ferb ? (
                      <span style={{ fontSize: '11px', fontWeight: '700', color: '#2563eb', background: '#dbeafe', padding: '2px 8px', borderRadius: '4px' }}>FERB</span>
                    ) : null}
                  </div>
                  <div style={{ fontSize: '13.5px', color: '#0f172a', lineHeight: '1.6', whiteSpace: 'pre-wrap' }}>{g.goal_text}</div>
                  {g.baseline_template && (
                    <div style={{ fontSize: '12px', color: '#64748b', marginTop: '6px', lineHeight: '1.5' }}>
                      <span style={{ fontWeight: '600' }}>Baseline:</span> {g.baseline_template}
                    </div>
                  )}
                </div>
                <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
                  <button
                    onClick={() => handleEdit(g)}
                    style={{ padding: '5px 12px', background: '#f1f5f9', border: 'none', borderRadius: '5px', fontSize: '12px', fontWeight: '500', cursor: 'pointer', color: '#374151' }}
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => handleDelete(g.id)}
                    style={{ padding: '5px 12px', background: '#fee2e2', border: 'none', borderRadius: '5px', fontSize: '12px', fontWeight: '500', cursor: 'pointer', color: '#dc2626' }}
                  >
                    Delete
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
