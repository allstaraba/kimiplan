import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  getPlanRevisions, getExportUrl, getChatHistory, sendChatMessage, regeneratePlan, chatRevisePlan,
  getPlan, addPlanGoal, updatePlanGoal, deletePlanGoal, getGoalBank, markClinicalReview
} from '../api.js';

// ── Plan text renderer ──────────────────────────────────────────────────────────

function parsePipeRows(content) {
  const rows = [];
  for (const line of content.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    rows.push(t.split('|').map(c => c.trim()));
  }
  return rows;
}

const TWO_COL_TABLES = new Set([
  'client_info', 'family_structure', 'medical_history',
  'school_placement', 'aba_history', 'other_mental_health',
  'other_services', 'coordination_table', 'major_life_changes', 'provider_info',
]);

function TableBlock({ name, content }) {
  const rows = parsePipeRows(content);
  if (rows.length === 0) return null;
  const isTwoCol = TWO_COL_TABLES.has(name);
  const hasHeader = !isTwoCol && rows.length > 1;
  const tdStyle = { border: '1px solid #cbd5e1', padding: '6px 10px', fontSize: '13px', verticalAlign: 'top', lineHeight: '1.5' };
  return (
    <div style={{ marginBottom: '14px', overflowX: 'auto' }}>
      <table style={{ borderCollapse: 'collapse', width: '100%', tableLayout: 'fixed' }}>
        <tbody>
          {rows.map((row, ri) => {
            const isHeaderRow = hasHeader && ri === 0;
            return (
              <tr key={ri} style={{ background: isHeaderRow ? '#f1f5f9' : (ri % 2 === 1 && !isTwoCol ? '#fafafa' : 'white') }}>
                {row.map((cell, ci) => {
                  const isLabel = isTwoCol && ci === 0;
                  const colWidth = isTwoCol ? (ci === 0 ? '35%' : '65%') : undefined;
                  const parts = cell.split(/\\n|\n/);
                  return (
                    <td key={ci} style={{ ...tdStyle, fontWeight: isHeaderRow || isLabel ? '600' : 'normal', width: colWidth }}>
                      {parts.map((p, pi) => <span key={pi}>{p}{pi < parts.length - 1 && <br />}</span>)}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function GoalBlock({ name, content }) {
  const lines = content.split('\n').map(l => l.trim()).filter(Boolean);
  const ratLines = [];
  let goalStat = '', baseline = '', dateIntro = '', projMastery = '', progressData = '';
  for (const line of lines) {
    if (line.startsWith('Medical Necessity Rationale') || line.startsWith('A.') || line.startsWith('B.') || line.startsWith('C.') || line.startsWith('●') || line.startsWith('•') || line.startsWith('-')) {
      ratLines.push(line);
    } else if (/^\d+\.\s*Goal Statement:/i.test(line) || /^goal statement:/i.test(line)) { goalStat = line; }
    else if (/^baseline:/i.test(line)) { baseline = line; }
    else if (/^date of introduction:/i.test(line)) { dateIntro = line; }
    else if (/^projected mastery:/i.test(line)) { projMastery = line; }
    else if (/^progress data:/i.test(line)) { progressData = line; }
    else { ratLines.push(line); }
  }
  const renderLabeled = (text, key) => {
    const ci = text.indexOf(':');
    if (ci === -1) return <div key={key} style={{ marginBottom: '4px' }}>{text}</div>;
    return <div key={key} style={{ marginBottom: '4px' }}><span style={{ fontWeight: '600' }}>{text.slice(0, ci + 1)}</span>{' ' + text.slice(ci + 1).trim()}</div>;
  };
  return (
    <div style={{ marginBottom: '18px', padding: '12px 14px', border: '1px solid #e2e8f0', borderRadius: '6px', background: '#fafafa' }}>
      <div style={{ fontWeight: '700', marginBottom: '8px', color: '#1e40af' }}>Goal {name}</div>
      {ratLines.map((line, i) => {
        if (line.startsWith('Medical Necessity Rationale')) return <div key={i} style={{ fontWeight: '600', marginBottom: '4px' }}>{line}</div>;
        if (line.startsWith('●') || line.startsWith('•') || line.startsWith('-')) return <div key={i} style={{ paddingLeft: '16px', marginBottom: '3px' }}>{line}</div>;
        return <div key={i} style={{ marginBottom: '3px' }}>{line}</div>;
      })}
      {goalStat && renderLabeled(goalStat, 'gs')}
      {baseline && renderLabeled(baseline, 'bl')}
      {dateIntro && renderLabeled(dateIntro, 'di')}
      {projMastery && renderLabeled(projMastery, 'pm')}
      {progressData && renderLabeled(progressData, 'pd')}
    </div>
  );
}

function BipBlock({ name, content }) {
  const lines = content.split('\n').map(l => l.trim()).filter(Boolean);
  const knownFields = ['Date:', 'Behavior Assessment:', 'Target Behavior:', 'Operational Definition:', 'Quantitative Baseline Data:', 'Hypothesized Function:', 'Functionally Equivalent Replacement Behaviors:', 'Antecedent Interventions:', 'Consequence Interventions:', 'De-escalation Procedures:'];
  const fields = [];
  let currentField = null, currentLines = [];
  const flush = () => { if (currentField !== null) { fields.push({ label: currentField, lines: [...currentLines] }); currentLines = []; } };
  for (const line of lines) {
    let matched = false;
    for (const f of knownFields) {
      if (line.toLowerCase().startsWith(f.toLowerCase())) {
        flush(); currentField = f.replace(/:$/, '');
        const rest = line.slice(f.length).trim();
        if (rest) currentLines.push(rest);
        matched = true; break;
      }
    }
    if (!matched) currentLines.push(line);
  }
  flush();
  const tdStyle = { border: '1px solid #cbd5e1', padding: '6px 10px', fontSize: '13px', verticalAlign: 'top', lineHeight: '1.5' };
  return (
    <div style={{ marginBottom: '18px' }}>
      <div style={{ fontWeight: '700', fontSize: '13.5px', marginBottom: '6px', color: '#0f172a' }}>Behavior Intervention Plan: {name}</div>
      <table style={{ borderCollapse: 'collapse', width: '100%', tableLayout: 'fixed' }}>
        <tbody>
          {fields.map((f, i) => (
            <tr key={i}>
              <td style={{ ...tdStyle, fontWeight: '600', width: '30%', background: '#f8fafc' }}>{f.label}</td>
              <td style={{ ...tdStyle, width: '70%' }}>
                {f.lines.map((line, li) => (
                  <div key={li} style={line.startsWith('●') || line.startsWith('•') || line.startsWith('-') ? { paddingLeft: '14px' } : {}}>{line}</div>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FadingPhaseBlock({ name, content }) {
  const lines = content.split('\n').map(l => l.trim()).filter(Boolean);
  return (
    <div style={{ marginBottom: '14px' }}>
      <div style={{ fontWeight: '600', marginBottom: '5px' }}>Phase {name}</div>
      {lines.map((line, i) => (
        <div key={i} style={{ paddingLeft: (line.startsWith('●') || line.startsWith('•') || line.startsWith('-')) ? '16px' : '0', marginBottom: '3px' }}>{line}</div>
      ))}
    </div>
  );
}

function CrisisRowBlock({ content }) {
  const rows = parsePipeRows(content);
  if (rows.length === 0) return null;
  const tdStyle = { border: '1px solid #cbd5e1', padding: '6px 10px', fontSize: '13px', verticalAlign: 'top' };
  return (
    <div style={{ marginBottom: '14px', overflowX: 'auto' }}>
      <table style={{ borderCollapse: 'collapse', width: '100%' }}>
        <tbody>
          {rows.map((row, ri) => (
            <tr key={ri} style={{ background: ri === 0 ? '#f1f5f9' : 'white' }}>
              {row.map((cell, ci) => <td key={ci} style={{ ...tdStyle, fontWeight: ri === 0 ? '600' : 'normal' }}>{cell}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TextBlock({ content }) {
  const lines = content.split('\n');
  const elements = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t) { elements.push(<div key={i} style={{ height: '6px' }} />); continue; }
    const secMatch = t.match(/^\[SECTION:([^\]]+)\](.*)$/);
    if (secMatch) {
      const heading = secMatch[2].trim();
      if (heading) elements.push(<div key={i} style={{ fontWeight: '700', fontSize: '14px', color: '#0f172a', textTransform: 'uppercase', marginTop: '14px', marginBottom: '5px', borderBottom: '1.5px solid #e2e8f0', paddingBottom: '3px' }}>{heading}</div>);
      continue;
    }
    if (/^\[\/?\w+\]$/.test(t)) continue;
    if (t.startsWith('# ')) { elements.push(<div key={i} style={{ fontWeight: '800', fontSize: '16px', textAlign: 'center', marginBottom: '8px', marginTop: '8px' }}>{t.slice(2)}</div>); }
    else if (t.startsWith('## ')) { elements.push(<div key={i} style={{ fontWeight: '700', fontSize: '14px', textTransform: 'uppercase', marginTop: '14px', marginBottom: '5px', borderBottom: '1.5px solid #e2e8f0', paddingBottom: '3px', color: '#0f172a' }}>{t.slice(3)}</div>); }
    else if (t.startsWith('### ')) { elements.push(<div key={i} style={{ fontWeight: '600', fontSize: '13.5px', marginTop: '10px', marginBottom: '4px' }}>{t.slice(4)}</div>); }
    else if (t.startsWith('●') || t.startsWith('•') || t.startsWith('- ')) { elements.push(<div key={i} style={{ paddingLeft: '18px', marginBottom: '3px' }}>{t}</div>); }
    else { elements.push(<div key={i} style={{ marginBottom: '4px' }}>{t}</div>); }
  }
  return <>{elements}</>;
}

function SectionBlock({ name, content }) {
  const headingMap = {
    title: null, review_checkbox: null,
    client_info: 'Client Information', biopsychosocial: 'Biopsychosocial Information',
    family_structure: 'Current Family Structure', medications: 'Medications',
    medical_history: 'Medical History', school_placement: 'School Placement',
    aba_history: 'History of ABA Services', other_mental_health: 'Other Mental Health Services',
    other_services: 'Other Services', coordination: 'Coordination of Care',
    coordination_table: null, major_life_changes: 'Major Life Changes',
    narrative: 'Narrative', strengths_challenges: 'Strengths, Challenges & Severity',
    standardized_assessment: 'Standardized Assessment', criterion_assessment: 'Criterion-Referenced Assessment',
    goal_summary: 'Goal Objective Summary', response_to_treatment: 'Response to Treatment',
    skill_acquisition: 'Skill Acquisition Goals', bips: 'Behavior Intervention Plans',
    behavior_reduction: 'Behavior Reduction Goals', parent_training: 'Parent or Caregiver Training',
    generalization: 'Generalization Plan', fading: 'Transition and Fading Plan',
    discharge: 'Discharge Criteria', crisis: 'Crisis Plan',
    recommendations: 'Recommendations for ABA Services', cpt_codes: 'CPT Codes',
    provider_info: 'Provider Information', consent: 'Consent',
  };
  const heading = headingMap[name];
  const trimmedContent = (content || '').trim();
  return (
    <div style={{ marginTop: '18px' }}>
      {heading && <div style={{ fontWeight: '700', fontSize: '14px', color: '#0f172a', textTransform: 'uppercase', marginBottom: '6px', borderBottom: '1.5px solid #e2e8f0', paddingBottom: '4px' }}>{heading}</div>}
      {trimmedContent && <TextBlock content={trimmedContent} />}
    </div>
  );
}

function renderPlanText(planText) {
  if (!planText) return null;
  if (!/\[\w+:[^\]]*\]/.test(planText)) {
    return <div style={{ whiteSpace: 'pre-wrap', fontFamily: 'system-ui, sans-serif', fontSize: '13.5px', lineHeight: '1.7', color: '#1e293b' }}>{planText}</div>;
  }
  const segments = [];
  const blockRegex = /\[(\w+):([^\]]*)\]([\s\S]*?)\[\/\1\]/g;
  let last = 0, m;
  while ((m = blockRegex.exec(planText)) !== null) {
    if (m.index > last) segments.push({ type: 'text', content: planText.slice(last, m.index) });
    segments.push({ type: m[1].toUpperCase(), name: m[2].trim(), content: m[3] });
    last = blockRegex.lastIndex;
  }
  if (last < planText.length) segments.push({ type: 'text', content: planText.slice(last) });
  return (
    <div style={{ fontFamily: 'system-ui, -apple-system, sans-serif', fontSize: '13.5px', lineHeight: '1.7', color: '#1e293b' }}>
      {segments.map((seg, i) => {
        switch (seg.type) {
          case 'SECTION': return <SectionBlock key={i} name={seg.name} content={seg.content} />;
          case 'TABLE': return <TableBlock key={i} name={seg.name} content={seg.content} />;
          case 'GOAL': return <GoalBlock key={i} name={seg.name} content={seg.content} />;
          case 'BIP': return <BipBlock key={i} name={seg.name} content={seg.content} />;
          case 'FADING_PHASE': return <FadingPhaseBlock key={i} name={seg.name} content={seg.content} />;
          case 'CRISIS_ROW': return <CrisisRowBlock key={i} content={seg.content} />;
          default: return <TextBlock key={i} content={seg.content} />;
        }
      })}
    </div>
  );
}

// ── Typing indicator ───────────────────────────────────────────────────────────
function TypingDots() {
  return (
    <div style={{ display: 'flex', gap: '4px', alignItems: 'center', padding: '10px 13px' }}>
      {[0, 1, 2].map(i => (
        <span key={i} style={{
          width: '7px', height: '7px', borderRadius: '50%', background: '#94a3b8',
          animation: 'pulse 1.2s ease-in-out infinite',
          animationDelay: `${i * 0.2}s`,
          display: 'inline-block',
        }} />
      ))}
      <style>{`@keyframes pulse { 0%,80%,100%{opacity:0.3} 40%{opacity:1} }`}</style>
    </div>
  );
}

// ── Chat message bubble ────────────────────────────────────────────────────────
function formatMsgTime(dt) {
  if (!dt) return '';
  const d = new Date(dt.endsWith('Z') ? dt : dt + 'Z');
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
}

function ChatBubble({ msg }) {
  const isUser = msg.role === 'user';
  const meta = [msg.username, formatMsgTime(msg.created_at)].filter(Boolean).join(' · ');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: isUser ? 'flex-end' : 'flex-start', marginBottom: '10px' }}>
      {meta && (
        <div style={{
          fontSize: '10px',
          color: '#94a3b8',
          marginBottom: '3px',
          paddingLeft: isUser ? '0' : '4px',
          paddingRight: isUser ? '4px' : '0',
        }}>
          {meta}
        </div>
      )}
      <div style={{
        maxWidth: '88%',
        padding: '9px 13px',
        borderRadius: isUser ? '12px 12px 2px 12px' : '12px 12px 12px 2px',
        background: isUser ? '#2563eb' : '#f1f5f9',
        color: isUser ? '#fff' : '#374151',
        fontSize: '13px',
        lineHeight: '1.6',
        whiteSpace: 'pre-wrap',
      }}>
        {msg.content}
      </div>
    </div>
  );
}

const EXAMPLE_PROMPTS = [
  "Change goal 5 to target 2-step directions",
  "Add a mouthing crisis protocol",
  "He also signs 'more' and 'eat'",
  "Phase 1 fading should include toileting",
];

function formatRevDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr.endsWith('Z') ? dateStr : dateStr + 'Z');
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
}

export default function ReviewRevise({ user, currentPlan, setCurrentPlan, injectedText, setInjectedText, generatingPlan, onRegeneratingChange, onRegenChunk }) {
  const [revisions, setRevisions] = useState([]);
  const [selectedRevIdx, setSelectedRevIdx] = useState(0);
  // Chat messages: [{role: 'user'|'assistant', content: '...'}]
  const [messages, setMessages] = useState([]);
  // Streaming assistant reply being built
  const [streamingReply, setStreamingReply] = useState('');
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [revising, setRevising] = useState(false);
  const [error, setError] = useState('');
  const [copySuccess, setCopySuccess] = useState(false);
  const [streamingPlanText, setStreamingPlanText] = useState('');
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);
  const navigate = useNavigate();

  // Clinical review + goals
  const [planDetails, setPlanDetails] = useState(null);
  const [planGoals, setPlanGoals] = useState([]);
  const [clinicalReviewLoading, setClinicalReviewLoading] = useState(false);
  const [showGoalPanel, setShowGoalPanel] = useState(false);
  const [goalBank, setGoalBank] = useState([]);
  const [selectedBankGoalId, setSelectedBankGoalId] = useState('');
  const [customGoal, setCustomGoal] = useState({ domain: 'Communication', goal_statement: '', baseline: '', is_ferb: false });
  const [goalLoading, setGoalLoading] = useState(false);


  // When injectedText arrives, put it in the input
  useEffect(() => {
    if (injectedText) {
      setInput(injectedText);
      if (setInjectedText) setInjectedText('');
      inputRef.current?.focus();
    }
  }, [injectedText]);

  // Load revisions + chat history when plan changes
  useEffect(() => {
    if (currentPlan?.plan_id) {
      setError('');
      setStreamingPlanText('');
      Promise.all([
        getPlanRevisions(currentPlan.plan_id),
        getChatHistory(currentPlan.plan_id),
        getPlan(currentPlan.plan_id),
        getGoalBank(),
      ]).then(([revs, chat, plan, bank]) => {
        setRevisions(revs);
        setSelectedRevIdx(revs.length - 1);
        setMessages(chat);
        setPlanDetails(plan);
        setPlanGoals(plan.goals || []);
        setGoalBank(bank || []);
      }).catch(err => setError(err.message));
    }
  }, [currentPlan?.plan_id]);

  // Auto-scroll chat to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingReply, sending, regenerating]);

  // Keep input focused after sends
  useEffect(() => {
    if (!sending && !regenerating) inputRef.current?.focus();
  }, [sending, regenerating]);

  // While a new plan is being generated, show a live streaming view
  if (!currentPlan && generatingPlan) {
    const liveText = (generatingPlan.text || '')
      .replace(/\[(SECTION|TABLE|\/TABLE|GOAL|\/GOAL|BIP|\/BIP|FADING_PHASE|\/FADING_PHASE|CRISIS_ROW|\/CRISIS_ROW):[^\]]*\]/g, '')
      .replace(/^\n{3,}/gm, '\n\n').trim();

    const sec = generatingPlan.section || 1;
    const total = generatingPlan.total || 4;
    const pct = Math.round(((sec - 1) / total) * 100);

    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>
        <div style={{ background: '#fff', borderBottom: '1px solid #e2e8f0', padding: '12px 24px', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '8px' }}>
            <span style={{ display: 'inline-block', width: '14px', height: '14px', border: '2px solid #bfdbfe', borderTopColor: '#2563eb', borderRadius: '50%', animation: 'spin 0.8s linear infinite', flexShrink: 0 }} />
            <span style={{ fontWeight: '700', fontSize: '15px', color: '#0f172a' }}>
              Generating section {sec} of {total}
            </span>
            <span style={{ fontSize: '13px', color: '#64748b' }}>— {generatingPlan.label}</span>
            <span style={{ marginLeft: 'auto', fontSize: '12px', color: '#94a3b8' }}>You can navigate away safely</span>
          </div>
          {/* Section progress bar */}
          <div style={{ height: '4px', background: '#f1f5f9', borderRadius: '2px', overflow: 'hidden' }}>
            <div style={{
              height: '100%', width: `${pct}%`,
              background: 'linear-gradient(90deg, #2563eb, #60a5fa)',
              borderRadius: '2px', transition: 'width 0.5s ease',
            }} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '4px' }}>
            {['Client Info & Assessments', 'Goals & BIPs', 'Behavior & Fading', 'Crisis & Consent'].map((lbl, i) => (
              <span key={i} style={{ fontSize: '10px', color: i < sec ? '#2563eb' : '#cbd5e1', fontWeight: i + 1 === sec ? '600' : '400' }}>
                {i + 1}. {lbl}
              </span>
            ))}
          </div>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '24px' }}>
          {liveText
            ? renderPlanText(liveText)
            : generatingPlan.reconnected
              ? <div style={{ color: '#64748b', fontSize: '14px', lineHeight: '1.6' }}>
                  <div style={{ marginBottom: '8px', fontWeight: '600', color: '#374151' }}>Generation is running on the server.</div>
                  <div>The connection was interrupted but the plan is still being generated. It will load automatically when complete — you do not need to do anything.</div>
                </div>
              : <div style={{ color: '#94a3b8', fontSize: '14px', lineHeight: '1.6' }}>
                  <div>Sending request to Claude — this usually takes 20–30 seconds to start…</div>
                </div>}
        </div>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  if (!currentPlan) {
    return (
      <div style={{ padding: '60px 32px', textAlign: 'center', color: '#64748b' }}>
        <div style={{ fontSize: '48px', marginBottom: '16px' }}>📋</div>
        <h2 style={{ fontSize: '20px', fontWeight: '600', color: '#374151', marginBottom: '8px' }}>No plan loaded</h2>
        <p style={{ marginBottom: '24px' }}>Go to Generate Plan to create one, or open a plan from Plan History.</p>
        <button onClick={() => navigate('/generate')} style={{ padding: '10px 24px', background: '#2563eb', border: 'none', borderRadius: '8px', color: '#fff', fontSize: '14px', fontWeight: '600', cursor: 'pointer' }}>
          Go to Generate Plan
        </button>
      </div>
    );
  }

  const selectedRevision = revisions[selectedRevIdx];
  const rawPlanText = streamingPlanText || selectedRevision?.text || '';
  const planText = rawPlanText
    .replace(/\[(SECTION|TABLE|\/TABLE|GOAL|\/GOAL|BIP|\/BIP|FADING_PHASE|\/FADING_PHASE|CRISIS_ROW|\/CRISIS_ROW):[^\]]*\]/g, '')
    .replace(/^\n{3,}/gm, '\n\n').trim();

  // Send a conversational message — Claude replies without regenerating the full plan
  const handleSend = async () => {
    const userMsg = input.trim();
    if (!userMsg || sending || regenerating) return;

    setInput('');
    setError('');
    setSending(true);

    const now = new Date().toISOString();
    const userMessage = { role: 'user', content: userMsg, username: user?.username || '', created_at: now };
    setMessages(prev => [...prev, userMessage]);

    let reply = '';
    setStreamingReply('');

    try {
      await sendChatMessage(currentPlan.plan_id, userMsg, (chunk) => {
        reply += chunk;
        setStreamingReply(reply);
      });
      setMessages(prev => [...prev, { role: 'assistant', content: reply, username: 'Claude', created_at: new Date().toISOString() }]);
      setStreamingReply('');
    } catch (err) {
      setError(err.message);
      setMessages(prev => [...prev, { role: 'assistant', content: `Error: ${err.message}` }]);
      setStreamingReply('');
    } finally {
      setSending(false);
    }
  };

  // Regenerate the complete plan incorporating all chat feedback
  const handleRegenerate = async () => {
    if (regenerating || sending || !currentPlan) return;
    setError('');
    setRegenerating(true);
    if (onRegeneratingChange) onRegeneratingChange(true, currentPlan.client_name || '');
    setStreamingPlanText('');

    // Add a system-style note to the chat
    setMessages(prev => [...prev, { role: 'assistant', content: 'Regenerating the full treatment plan with all your requested changes. This may take 1–2 minutes…', username: 'Claude', created_at: new Date().toISOString() }]);

    let newPlanText = '';
    try {
      const { revision_number } = await regeneratePlan(currentPlan.plan_id, (chunk) => {
        newPlanText += chunk;
        setStreamingPlanText(newPlanText);
        if (onRegenChunk) onRegenChunk(chunk);
      });

      // Load the saved revision
      const updatedRevisions = await getPlanRevisions(currentPlan.plan_id);
      setRevisions(updatedRevisions);
      setSelectedRevIdx(updatedRevisions.length - 1);
      setStreamingPlanText('');

      setMessages(prev => [...prev, { role: 'assistant', content: `Full plan regenerated — revision ${revision_number} saved. The updated plan is shown on the left.`, username: 'Claude', created_at: new Date().toISOString() }]);
    } catch (err) {
      setError(err.message);
      setStreamingPlanText('');
      setMessages(prev => [...prev, { role: 'assistant', content: `Regeneration failed: ${err.message}`, username: 'Claude', created_at: new Date().toISOString() }]);
    } finally {
      setRegenerating(false);
      if (onRegeneratingChange) onRegeneratingChange(false);
    }
  };

  // Apply only the specific changes mentioned in chat — find/replace, no full rewrite
  const handleChatRevise = async () => {
    if (revising || regenerating || sending) return;
    setError('');
    setRevising(true);

    setMessages(prev => [...prev, { role: 'assistant', content: 'Applying targeted changes…', username: 'Claude', created_at: new Date().toISOString() }]);

    try {
      const { revision_number } = await chatRevisePlan(currentPlan.plan_id);
      const updatedRevisions = await getPlanRevisions(currentPlan.plan_id);
      setRevisions(updatedRevisions);
      setSelectedRevIdx(updatedRevisions.length - 1);
      setMessages(prev => [...prev, { role: 'assistant', content: `Done — revision ${revision_number} saved with only your requested changes applied.`, username: 'Claude', created_at: new Date().toISOString() }]);
    } catch (err) {
      setError(err.message);
      setMessages(prev => [...prev, { role: 'assistant', content: `Revision failed: ${err.message}`, username: 'Claude', created_at: new Date().toISOString() }]);
    } finally {
      setRevising(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleExampleClick = (prompt) => {
    setInput(prompt);
    inputRef.current?.focus();
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(planText).then(() => {
      setCopySuccess(true);
      setTimeout(() => setCopySuccess(false), 2000);
    });
  };

  const handleDownload = async () => {
    const revNum = selectedRevision?.revision_number;
    if (revNum === undefined || revNum === null || regenerating) {
      setError('Please wait for the plan to finish before downloading.');
      return;
    }
    const url = getExportUrl(currentPlan.plan_id, revNum);
    const token = localStorage.getItem('allstar_token');
    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `Server error ${res.status}` }));
        throw new Error(err.error || 'Export failed');
      }
      const blob = await res.blob();
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      const safeName = (currentPlan.client_name || 'treatment-plan')
        .replace(/[^a-zA-Z0-9\s-]/g, '').replace(/\s+/g, '-').replace(/^-+|-+$/g, '') || 'treatment-plan';
      link.download = `treatment-plan-${safeName}-rev${revNum}.docx`;
      link.click();
      URL.revokeObjectURL(link.href);
    } catch (err) {
      setError('Download failed: ' + err.message);
    }
  };

  const revisionLabel = (rev) => {
    const ts = rev.created_at ? ` · ${formatRevDate(rev.created_at)}` : '';
    if (rev.revision_number === 0) return `Rev 0: Initial${ts}`;
    const preview = rev.feedback ? rev.feedback.substring(0, 30) : '';
    return `Rev ${rev.revision_number}: ${preview}${rev.feedback?.length > 30 ? '…' : ''}${ts}`;
  };

  // ── Clinical Review ──
  const handleToggleClinicalReview = async () => {
    if (!planDetails || !user) return;
    const next = !planDetails.clinical_review_complete;
    setClinicalReviewLoading(true);
    try {
      await markClinicalReview(currentPlan.plan_id, next);
      setPlanDetails(prev => ({ ...prev, clinical_review_complete: next }));
    } catch (err) {
      setError(err.message);
    } finally {
      setClinicalReviewLoading(false);
    }
  };

  // ── Goal Management ──
  const handleAddGoalFromBank = async () => {
    if (!selectedBankGoalId) return;
    const bankGoal = goalBank.find(g => g.id === Number(selectedBankGoalId));
    if (!bankGoal) return;
    setGoalLoading(true);
    try {
      await addPlanGoal(currentPlan.plan_id, {
        goal_bank_id: bankGoal.id,
        domain: bankGoal.domain,
        goal_statement: bankGoal.goal_text,
        baseline: bankGoal.baseline_template || '',
        is_ferb: bankGoal.is_ferb,
      });
      const updated = await getPlan(currentPlan.plan_id);
      setPlanGoals(updated.goals || []);
      setSelectedBankGoalId('');
    } catch (err) {
      setError(err.message);
    } finally {
      setGoalLoading(false);
    }
  };

  const handleAddCustomGoal = async () => {
    if (!customGoal.goal_statement.trim()) return;
    setGoalLoading(true);
    try {
      await addPlanGoal(currentPlan.plan_id, {
        domain: customGoal.domain,
        goal_statement: customGoal.goal_statement,
        baseline: customGoal.baseline,
        is_ferb: customGoal.is_ferb,
      });
      const updated = await getPlan(currentPlan.plan_id);
      setPlanGoals(updated.goals || []);
      setCustomGoal({ domain: 'Communication', goal_statement: '', baseline: '', is_ferb: false });
    } catch (err) {
      setError(err.message);
    } finally {
      setGoalLoading(false);
    }
  };

  const handleDeletePlanGoal = async (goalId) => {
    if (!window.confirm('Remove this goal from the plan?')) return;
    try {
      await deletePlanGoal(currentPlan.plan_id, goalId);
      setPlanGoals(prev => prev.filter(g => g.id !== goalId));
    } catch (err) {
      setError(err.message);
    }
  };

  const btnBase = {
    padding: '7px 16px',
    border: '1px solid #e2e8f0',
    borderRadius: '6px',
    fontSize: '13px',
    fontWeight: '500',
    cursor: 'pointer',
  };

  const hasUserMessages = messages.some(m => m.role === 'user');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>

      {/* ── Top Bar ── */}
      <div style={{ background: '#fff', borderBottom: '1px solid #e2e8f0', padding: '11px 24px', display: 'flex', alignItems: 'center', gap: '10px', flexShrink: 0 }}>
        <span style={{ fontWeight: '700', fontSize: '15px', color: '#0f172a', flex: 1 }}>
          Review & Revise
          {currentPlan.client_name && currentPlan.client_name !== 'Unknown' && (
            <span style={{ color: '#64748b', fontWeight: '400', marginLeft: '8px', fontSize: '14px' }}>— {currentPlan.client_name}</span>
          )}
        </span>
        <button onClick={() => { setCurrentPlan(null); navigate('/generate'); }} style={{ ...btnBase, background: '#f1f5f9', color: '#374151' }}>
          + New Plan
        </button>
        <button onClick={handleCopy} style={{ ...btnBase, background: copySuccess ? '#dcfce7' : '#f1f5f9', borderColor: copySuccess ? '#86efac' : '#e2e8f0', color: copySuccess ? '#16a34a' : '#374151' }}>
          {copySuccess ? '✓ Copied!' : 'Copy to Clipboard'}
        </button>
        <button onClick={() => navigate('/compliance')} style={{ ...btnBase, background: '#f1f5f9', color: '#374151' }}>
          Check Compliance
        </button>
        <button onClick={() => setShowGoalPanel(v => !v)} style={{ ...btnBase, background: showGoalPanel ? '#eff6ff' : '#f1f5f9', borderColor: showGoalPanel ? '#2563eb' : '#e2e8f0', color: showGoalPanel ? '#2563eb' : '#374151' }}>
          Goals {planGoals.length > 0 && `(${planGoals.length})`}
        </button>
        {planDetails && (
          <button
            onClick={handleToggleClinicalReview}
            disabled={clinicalReviewLoading}
            title={planDetails.clinical_review_complete ? 'Click to unmark clinical review' : 'Click to mark clinical review complete'}
            style={{
              ...btnBase,
              background: planDetails.clinical_review_complete ? '#dcfce7' : '#fef3c7',
              borderColor: planDetails.clinical_review_complete ? '#86efac' : '#fcd34d',
              color: planDetails.clinical_review_complete ? '#16a34a' : '#92400e',
            }}
          >
            {clinicalReviewLoading ? '…' : (planDetails.clinical_review_complete ? '✓ Clinical Review Complete' : 'Mark Clinical Review')}
          </button>
        )}
        <button onClick={handleDownload} style={{ ...btnBase, background: '#2563eb', border: 'none', color: '#fff' }}>
          Download .docx
        </button>
      </div>

      {/* ── Split View ── */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>

        {/* Left: Plan text (60%) */}
        <div style={{ flex: '0 0 60%', display: 'flex', flexDirection: 'column', borderRight: '1px solid #e2e8f0', overflow: 'hidden' }}>
          <div style={{ padding: '10px 20px', background: '#f8fafc', borderBottom: '1px solid #e2e8f0', display: 'flex', alignItems: 'center', gap: '10px', flexShrink: 0 }}>
            <label style={{ fontSize: '13px', color: '#64748b', fontWeight: '500' }}>Revision:</label>
            <select
              value={selectedRevIdx}
              onChange={e => { setSelectedRevIdx(Number(e.target.value)); setStreamingPlanText(''); }}
              style={{ padding: '5px 10px', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '13px', color: '#0f172a', background: '#fff', cursor: 'pointer' }}
            >
              {revisions.map((rev, idx) => (
                <option key={rev.id} value={idx}>{revisionLabel(rev)}</option>
              ))}
            </select>
            {(regenerating || revising) && (
              <span style={{ fontSize: '12px', color: '#2563eb', fontStyle: 'italic' }}>
                {revising ? 'Applying targeted changes…' : 'Regenerating plan…'}{streamingPlanText.length > 0 && ` · ${streamingPlanText.length.toLocaleString()} chars`}
              </span>
            )}
            <span style={{ marginLeft: 'auto', fontSize: '12px', color: '#94a3b8' }}>
              {revisions.length} revision{revisions.length !== 1 ? 's' : ''}
            </span>
          </div>
          {/* Goal Panel */}
          {showGoalPanel && (
            <div style={{ padding: '14px 20px', borderBottom: '1px solid #e2e8f0', background: '#fff', flexShrink: 0, maxHeight: '40%', overflowY: 'auto' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
                <div style={{ fontWeight: '700', fontSize: '13px', color: '#0f172a' }}>Plan Goals</div>
                <span style={{ fontSize: '12px', color: '#94a3b8' }}>{planGoals.length} attached</span>
              </div>

              {/* Add from bank */}
              <div style={{ display: 'flex', gap: '8px', marginBottom: '10px', flexWrap: 'wrap' }}>
                <select
                  value={selectedBankGoalId}
                  onChange={e => setSelectedBankGoalId(e.target.value)}
                  style={{ flex: 1, minWidth: '160px', padding: '6px 10px', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '13px' }}
                >
                  <option value="">Select from Goal Bank…</option>
                  {goalBank.map(g => (
                    <option key={g.id} value={g.id}>{g.domain} — {g.goal_text.slice(0, 60)}{g.goal_text.length > 60 ? '…' : ''}</option>
                  ))}
                </select>
                <button
                  onClick={handleAddGoalFromBank}
                  disabled={!selectedBankGoalId || goalLoading}
                  style={{ padding: '6px 14px', background: !selectedBankGoalId || goalLoading ? '#e2e8f0' : '#2563eb', border: 'none', borderRadius: '6px', color: !selectedBankGoalId || goalLoading ? '#94a3b8' : '#fff', fontSize: '12px', fontWeight: '600', cursor: !selectedBankGoalId || goalLoading ? 'not-allowed' : 'pointer' }}
                >
                  Add
                </button>
              </div>

              {/* Quick custom goal */}
              <details style={{ marginBottom: '10px' }}>
                <summary style={{ fontSize: '12px', color: '#64748b', cursor: 'pointer', fontWeight: '500' }}>Or write a custom goal…</summary>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '8px', padding: '10px', background: '#f8fafc', borderRadius: '6px' }}>
                  <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                    <select
                      value={customGoal.domain}
                      onChange={e => setCustomGoal(prev => ({ ...prev, domain: e.target.value }))}
                      style={{ padding: '5px 10px', border: '1px solid #e2e8f0', borderRadius: '5px', fontSize: '12px' }}
                    >
                      {['Communication','Social','Adaptive','Behavior Reduction','Caregiver Training'].map(d => <option key={d} value={d}>{d}</option>)}
                    </select>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '12px', color: '#374151' }}>
                      <input type="checkbox" checked={customGoal.is_ferb} onChange={e => setCustomGoal(prev => ({ ...prev, is_ferb: e.target.checked }))} />
                      FERB
                    </label>
                  </div>
                  <textarea
                    value={customGoal.goal_statement}
                    onChange={e => setCustomGoal(prev => ({ ...prev, goal_statement: e.target.value }))}
                    placeholder="Goal statement..."
                    rows={2}
                    style={{ padding: '6px 10px', border: '1px solid #e2e8f0', borderRadius: '5px', fontSize: '12px', resize: 'vertical', outline: 'none', fontFamily: 'inherit' }}
                  />
                  <textarea
                    value={customGoal.baseline}
                    onChange={e => setCustomGoal(prev => ({ ...prev, baseline: e.target.value }))}
                    placeholder="Baseline (optional)..."
                    rows={1}
                    style={{ padding: '6px 10px', border: '1px solid #e2e8f0', borderRadius: '5px', fontSize: '12px', resize: 'vertical', outline: 'none', fontFamily: 'inherit' }}
                  />
                  <button
                    onClick={handleAddCustomGoal}
                    disabled={!customGoal.goal_statement.trim() || goalLoading}
                    style={{ padding: '5px 12px', background: !customGoal.goal_statement.trim() || goalLoading ? '#e2e8f0' : '#0f172a', border: 'none', borderRadius: '5px', color: !customGoal.goal_statement.trim() || goalLoading ? '#94a3b8' : '#fff', fontSize: '12px', fontWeight: '600', cursor: !customGoal.goal_statement.trim() || goalLoading ? 'not-allowed' : 'pointer', alignSelf: 'flex-start' }}
                  >
                    Add Custom Goal
                  </button>
                </div>
              </details>

              {/* Attached goals list */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {planGoals.length === 0 ? (
                  <div style={{ fontSize: '12px', color: '#94a3b8', padding: '8px 0' }}>No goals attached yet. Use the Goal Bank or write custom goals above.</div>
                ) : (
                  planGoals.map(g => (
                    <div key={g.id} style={{ padding: '8px 12px', background: '#f8fafc', borderRadius: '6px', border: '1px solid #e2e8f0' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
                        <span style={{ fontSize: '10px', fontWeight: '700', textTransform: 'uppercase', padding: '1px 6px', borderRadius: '4px', background: '#dbeafe', color: '#1e40af' }}>{g.domain}</span>
                        <span style={{ fontSize: '11px', fontWeight: '700', color: '#64748b' }}>Goal {g.goal_number}</span>
                        {g.is_ferb ? <span style={{ fontSize: '10px', fontWeight: '700', color: '#2563eb' }}>FERB</span> : null}
                        <button
                          onClick={() => handleDeletePlanGoal(g.id)}
                          style={{ marginLeft: 'auto', padding: '2px 8px', background: '#fee2e2', border: 'none', borderRadius: '4px', fontSize: '11px', color: '#dc2626', cursor: 'pointer' }}
                        >
                          Remove
                        </button>
                      </div>
                      <div style={{ fontSize: '12.5px', color: '#0f172a', lineHeight: '1.5' }}>{g.goal_statement}</div>
                      {g.baseline && <div style={{ fontSize: '11px', color: '#64748b', marginTop: '3px' }}>Baseline: {g.baseline}</div>}
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          <div style={{ flex: 1, overflowY: 'auto', padding: '24px' }}>
            {planText
              ? renderPlanText(planText)
              : <span style={{ color: '#94a3b8' }}>No plan text yet.</span>}
          </div>
        </div>

        {/* Right: Chat (40%) */}
        <div style={{ flex: '0 0 40%', display: 'flex', flexDirection: 'column', background: '#fff', overflow: 'hidden' }}>

          {/* Chat header */}
          <div style={{ padding: '12px 20px', borderBottom: '1px solid #e2e8f0', background: '#f8fafc', flexShrink: 0, display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: '14px', fontWeight: '600', color: '#0f172a' }}>Revision Chat</div>
              <div style={{ fontSize: '12px', color: '#94a3b8', marginTop: '1px' }}>Chat about changes · Enter sends · Shift+Enter = new line</div>
            </div>
            {hasUserMessages && (
              <div style={{ display: 'flex', gap: '6px' }}>
                <button
                  onClick={handleChatRevise}
                  disabled={revising || regenerating || sending}
                  title="Apply only the specific changes from this chat — everything else stays exactly the same (fast)"
                  style={{
                    padding: '7px 13px',
                    background: revising || regenerating || sending ? '#e2e8f0' : '#2563eb',
                    border: 'none', borderRadius: '6px',
                    color: revising || regenerating || sending ? '#94a3b8' : '#fff',
                    fontSize: '12px', fontWeight: '600',
                    cursor: revising || regenerating || sending ? 'not-allowed' : 'pointer',
                    whiteSpace: 'nowrap', transition: 'background 0.15s',
                  }}
                >
                  {revising ? 'Revising…' : 'Revise'}
                </button>
                <button
                  onClick={handleRegenerate}
                  disabled={regenerating || revising || sending}
                  title="Regenerate the full plan from scratch incorporating all chat feedback (thorough, takes 1–2 min)"
                  style={{
                    padding: '7px 13px',
                    background: regenerating || revising || sending ? '#e2e8f0' : '#0f172a',
                    border: 'none', borderRadius: '6px',
                    color: regenerating || revising || sending ? '#94a3b8' : '#fff',
                    fontSize: '12px', fontWeight: '600',
                    cursor: regenerating || revising || sending ? 'not-allowed' : 'pointer',
                    whiteSpace: 'nowrap', transition: 'background 0.15s',
                  }}
                >
                  {regenerating ? 'Regenerating…' : 'Regenerate'}
                </button>
              </div>
            )}
          </div>

          {/* Messages area */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px' }}>
            {messages.length === 0 && !sending ? (
              <div>
                <p style={{ fontSize: '13px', color: '#94a3b8', marginBottom: '14px' }}>
                  Chat about changes to the plan. Use <strong>Revise</strong> to apply only what you mentioned (fast), or <strong>Regenerate</strong> to fully rewrite the plan with all changes (thorough).
                </p>
                <p style={{ fontSize: '12px', color: '#94a3b8', marginBottom: '12px', fontWeight: '500' }}>Try an example:</p>
                {EXAMPLE_PROMPTS.map((prompt, i) => (
                  <button
                    key={i}
                    onClick={() => handleExampleClick(prompt)}
                    style={{
                      display: 'block', width: '100%', textAlign: 'left',
                      padding: '9px 13px', marginBottom: '8px',
                      background: '#f1f5f9', border: '1px solid #e2e8f0',
                      borderRadius: '8px', fontSize: '13px', color: '#374151', cursor: 'pointer',
                    }}
                    onMouseEnter={e => e.currentTarget.style.background = '#e2e8f0'}
                    onMouseLeave={e => e.currentTarget.style.background = '#f1f5f9'}
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            ) : (
              <>
                {messages.map((msg, i) => <ChatBubble key={i} msg={msg} />)}
                {sending && streamingReply && (
                  <ChatBubble msg={{ role: 'assistant', content: streamingReply }} />
                )}
                {sending && !streamingReply && (
                  <div style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: '10px' }}>
                    <div style={{ background: '#f1f5f9', borderRadius: '12px 12px 12px 2px' }}>
                      <TypingDots />
                    </div>
                  </div>
                )}
              </>
            )}
            <div ref={messagesEndRef} />
          </div>

          {error && (
            <div style={{ padding: '8px 20px', background: '#fef2f2', borderTop: '1px solid #fecaca', color: '#dc2626', fontSize: '13px', flexShrink: 0 }}>
              {error}
            </div>
          )}

          <div style={{ padding: '14px 20px', borderTop: '1px solid #e2e8f0', display: 'flex', gap: '10px', flexShrink: 0, background: '#fff' }}>
            <textarea
              ref={inputRef}
              autoFocus
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Tell me what to change…"
              rows={3}
              style={{
                flex: 1, padding: '10px 13px',
                border: '1.5px solid #e2e8f0', borderRadius: '8px',
                fontSize: '13px', resize: 'none', outline: 'none',
                fontFamily: 'inherit', color: '#0f172a', lineHeight: '1.5',
              }}
              onFocus={e => e.target.style.borderColor = '#2563eb'}
              onBlur={e => e.target.style.borderColor = '#e2e8f0'}
            />
            <button
              onClick={handleSend}
              disabled={!input.trim() || regenerating}
              style={{
                padding: '10px 16px',
                background: !input.trim() || regenerating ? '#93c5fd' : '#2563eb',
                border: 'none', borderRadius: '8px', color: '#fff',
                fontSize: '13px', fontWeight: '600',
                cursor: !input.trim() || regenerating ? 'not-allowed' : 'pointer',
                alignSelf: 'flex-end', whiteSpace: 'nowrap',
                transition: 'background 0.15s',
              }}
            >
              {sending ? '…' : 'Send'}
            </button>
          </div>

        </div>
      </div>
    </div>
  );
}
