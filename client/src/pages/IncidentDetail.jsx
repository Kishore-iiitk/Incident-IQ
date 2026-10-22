import React, { useState, useEffect } from 'react';
import {
  ArrowLeft, RefreshCw, ShieldAlert, Users, CheckCircle2,
  AlertTriangle, Terminal, Sparkles, FileText, ChevronDown,
  ChevronUp, ExternalLink, Activity, Info, FileCode, Image, Mic, Mail,
  Check, Edit3, X, Link2
} from 'lucide-react';
import SeverityBadge from '../components/SeverityBadge.jsx';
import StatusBadge from '../components/StatusBadge.jsx';
import StageProgress from '../components/StageProgress.jsx';
import { getIncident, reviewIncident, resolveIncident, retryIncident } from '../api.js';

export default function IncidentDetail({ incidentId, onBack, socket }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [retrying, setRetrying] = useState(false);

  // Live pipeline state tracking
  const [currentRunningStage, setCurrentRunningStage] = useState(null);
  const [completedStages, setCompletedStages] = useState([]);
  const [failedStage, setFailedStage] = useState(null);
  const [stageErrorMessage, setStageErrorMessage] = useState(null);
  const [showRawJson, setShowRawJson] = useState(false);

  // Human Review State
  const [editingField, setEditingField] = useState(null); // 'severity' | 'root_cause' | 'assigned_team'
  const [editValue, setEditValue] = useState('');
  const [reviewSubmitting, setReviewSubmitting] = useState(false);

  // Resolve Modal State
  const [showResolveModal, setShowResolveModal] = useState(false);
  const [resolveRootCause, setResolveRootCause] = useState('');
  const [resolveFix, setResolveFix] = useState('');
  const [resolveSymptoms, setResolveSymptoms] = useState('');
  const [resolvePendingNotice, setResolvePendingNotice] = useState(null);
  const [resolving, setResolving] = useState(false);

  const fetchDetails = async () => {
    try {
      setLoading(true);
      const json = await getIncident(incidentId);
      setData(json);

      // Hydrate completed stages from existing analyses and incident doc
      const doneFromAnalyses = (json.analyses || []).map(a => a.stage);
      const doneFromIncident = json.incident?.stages_completed || [];
      const combinedDone = Array.from(new Set([...doneFromAnalyses, ...doneFromIncident]));
      if (combinedDone.length > 0) {
        setCompletedStages(combinedDone);
      }

      if (json.incident?.status === 'failed') {
        setFailedStage(json.incident.failed_stage);
        setStageErrorMessage(json.incident.error_message);
      } else if (json.incident?.status === 'review') {
        setFailedStage(null);
      }
    } catch (err) {
      console.error('Fetch error:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchDetails();
  }, [incidentId]);

  // Socket.IO real-time event listener
  useEffect(() => {
    if (!socket) return;

    const handleStageStart = (payload) => {
      if (payload.incidentId === incidentId) {
        setCurrentRunningStage(payload.stage);
      }
    };

    const handleStageEnd = (payload) => {
      if (payload.incidentId === incidentId) {
        if (payload.status === 'completed') {
          setCompletedStages(prev => Array.from(new Set([...prev, payload.stage])));
          setCurrentRunningStage(null);
          fetchDetails();
        } else if (payload.status === 'failed') {
          setFailedStage(payload.stage);
          setStageErrorMessage(payload.error);
          setCurrentRunningStage(null);
          fetchDetails();
        }
      }
    };

    const handleCompleted = (payload) => {
      if (payload.incidentId === incidentId) {
        setCurrentRunningStage(null);
        fetchDetails();
      }
    };

    const handleFailed = (payload) => {
      if (payload.incidentId === incidentId) {
        setFailedStage(payload.stage);
        setStageErrorMessage(payload.error);
        setCurrentRunningStage(null);
        fetchDetails();
      }
    };

    socket.on('pipeline:stage_start', handleStageStart);
    socket.on('pipeline:stage_end', handleStageEnd);
    socket.on('pipeline:completed', handleCompleted);
    socket.on('pipeline:failed', handleFailed);

    return () => {
      socket.off('pipeline:stage_start', handleStageStart);
      socket.off('pipeline:stage_end', handleStageEnd);
      socket.off('pipeline:completed', handleCompleted);
      socket.off('pipeline:failed', handleFailed);
    };
  }, [socket, incidentId]);

  // Handle Retry Analysis (Problem 3)
  const handleRetryAnalysis = async () => {
    try {
      setRetrying(true);
      await retryIncident(incidentId);
      await fetchDetails();
    } catch (err) {
      console.error('Retry failed:', err);
      alert(err.message || 'Failed to retry incident analysis');
    } finally {
      setRetrying(false);
    }
  };

  // Handle Review action (approve or edit)
  const handleReviewAction = async (field, action, customNewValue = null) => {
    try {
      setReviewSubmitting(true);
      const val = action === 'edit' ? (customNewValue || editValue) : null;
      await reviewIncident(incidentId, {
        field,
        action,
        new_value: val,
        reviewer: 'oncall_engineer'
      });
      setEditingField(null);
      setEditValue('');
      await fetchDetails();
    } catch (err) {
      console.error('Review submit failed:', err);
      alert(err.message || 'Failed to record review');
    } finally {
      setReviewSubmitting(false);
    }
  };

  // Handle Mark Resolved
  const handleResolveSubmit = async (e) => {
    e.preventDefault();
    if (!resolveRootCause || !resolveFix) return;

    try {
      setResolving(true);
      const json = await resolveIncident(incidentId, {
        root_cause: resolveRootCause,
        resolution: resolveFix,
        symptoms: resolveSymptoms
      });

      if (json && json.pending_embedding) {
        setResolvePendingNotice('Resolved. Note: ML embedding service was unavailable; entry saved with pending embedding.');
      } else {
        setShowResolveModal(false);
      }
      await fetchDetails();
    } catch (err) {
      console.error('Resolve failed:', err);
      alert(err.message || 'Failed to resolve incident');
    } finally {
      setResolving(false);
    }
  };

  if (loading && !data) {
    return (
      <div className="max-w-7xl mx-auto px-4 py-16 text-center">
        <RefreshCw className="w-8 h-8 animate-spin text-indigo-400 mx-auto mb-3" />
        <p className="text-sm font-mono text-slate-400">Loading incident telemetry...</p>
      </div>
    );
  }

  if (error || !data?.incident) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-12">
        <div className="p-6 rounded-xl bg-rose-950/40 border border-rose-800 text-rose-200">
          <h2 className="text-lg font-bold mb-2">Error Loading Incident</h2>
          <p className="text-sm">{error || 'Incident details could not be found.'}</p>
          <button
            onClick={onBack}
            className="mt-4 px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-white text-xs font-semibold cursor-pointer"
          >
            Return to Dashboard
          </button>
        </div>
      </div>
    );
  }

  const { incident, evidence = [], analyses = [], reviews = [] } = data;

  const triageAnalysis = analyses.find(a => a.stage === 'triage')?.output;
  const rootCauseAnalysis = analyses.find(a => a.stage === 'root_cause')?.output;
  const routerAnalysis = analyses.find(a => a.stage === 'router')?.output;
  const writerAnalysis = analyses.find(a => a.stage === 'writer')?.output;

  const isDemoCached = analyses.some(a => a.output?._demo_mode || a.model?.includes('DEMO_MODE'));

  const openResolveModal = () => {
    setResolveRootCause(rootCauseAnalysis?.probable_root_cause || '');
    setResolveFix(writerAnalysis?.suggested_fixes?.[0] || '');
    setResolveSymptoms(incident.description || '');
    setShowResolveModal(true);
  };

  const getEvidenceById = (refId) => {
    if (!refId) return null;
    return evidence.find(e => e.id === refId || e._id === refId);
  };

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
      {/* Resolve Notice Alert */}
      {resolvePendingNotice && (
        <div className="p-4 rounded-xl bg-amber-950/60 border border-amber-600/60 flex items-center justify-between text-amber-200 text-xs font-mono">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-400" />
            <span>{resolvePendingNotice}</span>
          </div>
          <button onClick={() => setResolvePendingNotice(null)} className="text-amber-400 hover:text-white">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Top Navigation & Status Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <button
            onClick={onBack}
            className="p-2 rounded-lg bg-slate-900 hover:bg-slate-800 text-slate-300 border border-slate-800 transition-colors cursor-pointer"
            title="Back to Dashboard"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-mono text-slate-500">INCIDENT ID: {incident._id}</span>
              {isDemoCached && (
                <span className="px-2 py-0.5 rounded text-[10px] font-mono font-semibold bg-amber-500/20 text-amber-300 border border-amber-500/30">
                  DEMO CACHE
                </span>
              )}
              {incident.needs_review && (
                <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-amber-500/20 text-amber-300 border border-amber-500/40 animate-pulse">
                  ⚠️ NEEDS REVIEW
                </span>
              )}
            </div>
            <h1 className="text-xl sm:text-2xl font-extrabold text-white tracking-tight">
              {incident.title}
            </h1>
          </div>
        </div>

        <div className="flex items-center gap-2.5 flex-wrap">
          <SeverityBadge severity={incident.severity} />
          <StatusBadge status={incident.status} />
          {incident.assigned_team && (
            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-mono font-semibold bg-indigo-950/60 text-indigo-300 border border-indigo-500/30">
              <Users className="w-3.5 h-3.5 text-indigo-400" />
              <span>Team: {incident.assigned_team}</span>
            </span>
          )}

          {/* Mark Resolved Button */}
          {incident.status !== 'resolved' && (
            <button
              onClick={openResolveModal}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold shadow-md shadow-emerald-900/30 transition-all cursor-pointer"
            >
              <CheckCircle2 className="w-3.5 h-3.5" />
              <span>Resolve Incident</span>
            </button>
          )}

          {/* Retry Analysis Button */}
          {incident.status === 'failed' && (
            <button
              onClick={handleRetryAnalysis}
              disabled={retrying}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-500 disabled:opacity-50 text-white text-xs font-semibold shadow-md shadow-rose-900/30 transition-all cursor-pointer"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${retrying ? 'animate-spin' : ''}`} />
              <span>Retry analysis</span>
            </button>
          )}

          <button
            onClick={fetchDetails}
            className="p-2 rounded-md bg-slate-900 hover:bg-slate-800 text-slate-400 border border-slate-800 cursor-pointer"
            title="Refresh"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Prominent Failed Incident Banner (Problem 3) */}
      {incident.status === 'failed' && (
        <div className="p-4 rounded-xl bg-rose-950/60 border border-rose-600/60 flex flex-col sm:flex-row sm:items-center justify-between gap-4 text-rose-200">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-rose-400 shrink-0 mt-0.5" />
            <div>
              <div className="font-bold text-sm text-white">
                Pipeline Execution Failed at Stage: <span className="font-mono text-rose-300 uppercase">{incident.failed_stage || failedStage || 'Unknown'}</span>
              </div>
              <p className="text-xs text-rose-300/90 mt-1">
                {incident.error_message || stageErrorMessage || 'The autonomous pipeline encountered an error during processing.'}
              </p>
              {completedStages && completedStages.length > 0 && (
                <div className="text-[11px] font-mono text-slate-400 mt-2">
                  Retained completed stage results: <span className="text-emerald-400">{completedStages.join(', ')}</span>
                </div>
              )}
            </div>
          </div>
          <button
            onClick={handleRetryAnalysis}
            disabled={retrying}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-rose-600 hover:bg-rose-500 disabled:opacity-50 text-white text-xs font-bold transition-all shadow-md shrink-0 cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${retrying ? 'animate-spin' : ''}`} />
            <span>Retry analysis</span>
          </button>
        </div>
      )}

      {/* 7-Stage Live Pipeline Stepper */}
      <StageProgress
        currentStage={currentRunningStage}
        completedStages={completedStages}
        failedStage={incident.failed_stage || failedStage}
        errorMessage={stageErrorMessage || incident.error_message}
        analyses={analyses}
      />

      {/* Narrative & Ingested Report Section */}
      <div className="glass-panel p-5">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-xs font-mono font-bold uppercase tracking-wider text-slate-400">
            Ingested Narrative & Free-Text Error Report
          </h2>
          <span className="text-[11px] font-mono text-slate-500">
            Received: {new Date(incident.created_at).toLocaleString()}
          </span>
        </div>
        <p className="text-sm font-mono text-slate-200 bg-slate-950/70 p-3.5 rounded-lg border border-slate-800/80 leading-relaxed">
          {incident.description}
        </p>
      </div>

      {/* Multimodal Evidence Processors Status & Evidence Summary */}
      {evidence && evidence.length > 0 && (
        <div className="glass-panel p-5 space-y-4">
          <div className="flex items-center justify-between border-b border-slate-800 pb-3">
            <div className="flex items-center gap-2">
              <Activity className="w-4 h-4 text-indigo-400" />
              <h2 className="text-sm font-bold text-white uppercase font-mono tracking-wide">
                Multimodal Evidence Processors ({evidence.length})
              </h2>
            </div>
            <span className="text-xs font-mono text-slate-400">
              Parallel execution via Promise.allSettled
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {evidence.map((ev, idx) => {
              const status = ev.status || 'ok';
              const statusColor =
                status === 'ok' || status === 'success'
                  ? 'bg-emerald-950/40 text-emerald-300 border-emerald-800/60'
                  : status === 'failed'
                    ? 'bg-rose-950/40 text-rose-300 border-rose-800/60'
                    : 'bg-slate-800/40 text-slate-400 border-slate-700/60';

              return (
                <div key={idx} id={`ev-${ev.id}`} className="p-4 rounded-xl bg-slate-950/60 border border-slate-800/80 space-y-2.5">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-mono font-bold text-indigo-400">
                        {ev.id || `EV-${String(idx + 1).padStart(2, '0')}`}
                      </span>
                      <span className="text-xs font-mono text-slate-300 capitalize">
                        {ev.source?.replace('_', ' ') || ev.type}
                      </span>
                    </div>
                    <span className={`px-2 py-0.5 rounded text-[10px] font-mono font-semibold uppercase border ${statusColor}`}>
                      {status}
                    </span>
                  </div>

                  <p className="text-xs text-slate-300 leading-relaxed">
                    {ev.summary}
                  </p>

                  {ev.metadata?.ocrText && (
                    <div className="text-[11px] font-mono text-slate-400 bg-slate-900/60 p-2 rounded border border-slate-800">
                      <span className="text-slate-500 block text-[10px] uppercase font-bold">OCR Extract:</span>
                      {ev.metadata.ocrText.slice(0, 150)}...
                    </div>
                  )}

                  {ev.metadata?.speechResult?.transcript && (
                    <div className="text-[11px] font-mono text-slate-400 bg-slate-900/60 p-2 rounded border border-slate-800">
                      <span className="text-slate-500 block text-[10px] uppercase font-bold">Audio Transcript:</span>
                      "{ev.metadata.speechResult.transcript.slice(0, 150)}..."
                    </div>
                  )}

                  <div className="flex flex-wrap gap-2 pt-1 text-[11px] font-mono">
                    {ev.metadata?.sentiment && (
                      <span className="text-amber-400">
                        Sentiment: {ev.metadata.sentiment}
                      </span>
                    )}
                    {ev.errors && ev.errors.length > 0 && (
                      <span className="text-rose-400">
                        Errors: {ev.errors.slice(0, 2).join(', ')}
                      </span>
                    )}
                    {ev.entities && ev.entities.length > 0 && (
                      <span className="text-slate-400">
                        Entities: {ev.entities.slice(0, 3).join(', ')}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Grid of Results: Triage (with Human Review) & Router (with Human Review) */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Triage Findings */}
        <div className="glass-panel p-5 lg:col-span-2 space-y-4">
          <div className="flex items-center justify-between border-b border-slate-800 pb-3">
            <div className="flex items-center gap-2">
              <ShieldAlert className="w-4 h-4 text-indigo-400" />
              <h2 className="text-sm font-bold text-white uppercase font-mono tracking-wide">
                Stage 4: Triage & Hybrid Severity
              </h2>
            </div>
            {triageAnalysis?.hybrid_confidence !== undefined && (
              <span className="text-xs font-mono text-emerald-400 bg-emerald-950/40 px-2 py-0.5 rounded border border-emerald-800/50">
                Confidence: {(triageAnalysis.hybrid_confidence * 100).toFixed(0)}%
              </span>
            )}
          </div>

          {/* Severity Review Action Box */}
          <div className="p-3.5 rounded-xl bg-slate-950/70 border border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <span className="text-xs font-mono uppercase text-slate-400">Assessed Severity:</span>
                <SeverityBadge severity={incident.severity} />
                {triageAnalysis?.components?.llm && triageAnalysis.components.llm !== incident.severity && (
                  <span className="text-[11px] font-mono text-slate-500">
                    (Original AI: {triageAnalysis.components.llm})
                  </span>
                )}
              </div>
              {triageAnalysis?.degraded && triageAnalysis.degraded.length > 0 && (
                <div className="text-[11px] font-mono text-amber-400">
                  Degraded mode: {triageAnalysis.degraded.join(', ')}
                </div>
              )}
            </div>

            <div className="flex items-center gap-2">
              {editingField === 'severity' ? (
                <div className="flex items-center gap-1.5">
                  {['P1', 'P2', 'P3', 'P4'].map(sev => (
                    <button
                      key={sev}
                      onClick={() => handleReviewAction('severity', 'edit', sev)}
                      disabled={reviewSubmitting}
                      className="px-2.5 py-1 rounded text-xs font-mono font-bold bg-slate-800 hover:bg-indigo-600 text-white border border-slate-700 cursor-pointer"
                    >
                      {sev}
                    </button>
                  ))}
                  <button
                    onClick={() => setEditingField(null)}
                    className="p-1 text-slate-400 hover:text-white"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleReviewAction('severity', 'approve')}
                    disabled={reviewSubmitting}
                    className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-300 border border-emerald-500/30 text-xs font-semibold cursor-pointer"
                  >
                    <Check className="w-3.5 h-3.5" />
                    <span>Approve</span>
                  </button>
                  <button
                    onClick={() => setEditingField('severity')}
                    className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 text-xs font-semibold cursor-pointer"
                  >
                    <Edit3 className="w-3.5 h-3.5" />
                    <span>Edit</span>
                  </button>
                </div>
              )}
            </div>
          </div>

          {triageAnalysis ? (
            <div className="space-y-4">
              <div>
                <span className="text-xs font-mono uppercase text-slate-400 block mb-1">Blast Radius Assessment:</span>
                <p className="text-xs text-slate-300 bg-slate-950/50 p-3 rounded-lg border border-slate-800/80 leading-relaxed">
                  {triageAnalysis.blast_radius}
                </p>
              </div>

              <div>
                <span className="text-xs font-mono uppercase text-slate-400 block mb-1.5">Affected Technical Subsystems:</span>
                <div className="flex flex-wrap gap-1.5">
                  {triageAnalysis.affected_systems.map((sys, idx) => (
                    <span
                      key={idx}
                      className="px-2.5 py-1 rounded bg-indigo-950/50 text-indigo-200 border border-indigo-800/50 text-xs font-mono font-medium"
                    >
                      {sys}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <div className="py-6 text-center text-xs font-mono text-slate-500">
              {incident.status === 'processing' ? 'Waiting for Triage Agent execution...' : 'Triage analysis not available.'}
            </div>
          )}
        </div>

        {/* Router / Ownership (with Human Review) */}
        <div className="glass-panel p-5 space-y-4">
          <div className="flex items-center justify-between border-b border-slate-800 pb-3">
            <div className="flex items-center gap-2">
              <Users className="w-4 h-4 text-indigo-400" />
              <h2 className="text-sm font-bold text-white uppercase font-mono tracking-wide">
                Stage 6: Team Routing
              </h2>
            </div>
          </div>

          {/* Team Review Action Box */}
          <div className="p-3 rounded-lg bg-slate-950/70 border border-slate-800 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-mono uppercase text-slate-400">Assigned Team:</span>
              <div className="flex items-center gap-1.5">
                {editingField === 'assigned_team' ? (
                  <div className="flex items-center gap-1">
                    {['Backend', 'Database', 'Auth', 'File Service'].map(tm => (
                      <button
                        key={tm}
                        onClick={() => handleReviewAction('assigned_team', 'edit', tm)}
                        className="px-2 py-0.5 rounded text-[10px] font-mono font-semibold bg-slate-800 hover:bg-indigo-600 text-white cursor-pointer"
                      >
                        {tm}
                      </button>
                    ))}
                    <button onClick={() => setEditingField(null)} className="p-1 text-slate-400">
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={() => handleReviewAction('assigned_team', 'approve')}
                      className="px-2 py-1 rounded bg-emerald-600/20 text-emerald-300 border border-emerald-500/30 text-[11px] font-semibold cursor-pointer"
                    >
                      Approve
                    </button>
                    <button
                      onClick={() => setEditingField('assigned_team')}
                      className="px-2 py-1 rounded bg-slate-800 text-slate-300 border border-slate-700 text-[11px] font-semibold cursor-pointer"
                    >
                      Edit
                    </button>
                  </div>
                )}
              </div>
            </div>

            <div className="text-base font-extrabold text-white font-mono bg-slate-900/60 p-2.5 rounded border border-slate-800 flex items-center justify-between">
              <span>{incident.assigned_team || routerAnalysis?.team || 'Unassigned'}</span>
              <CheckCircle2 className="w-4 h-4 text-emerald-400" />
            </div>
          </div>

          {routerAnalysis ? (
            <div>
              <span className="text-xs font-mono uppercase text-slate-400 block mb-1">Routing Justification:</span>
              <ul className="space-y-1.5">
                {routerAnalysis.reasons.map((r, i) => (
                  <li key={i} className="text-xs text-slate-300 flex items-start gap-2 bg-slate-950/40 p-2 rounded border border-slate-800/60">
                    <span className="text-indigo-400 font-bold">•</span>
                    <span>{r}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="py-6 text-center text-xs font-mono text-slate-500">
              {incident.status === 'processing' ? 'Awaiting Router stage...' : 'Routing not completed.'}
            </div>
          )}
        </div>
      </div>

      {/* Stage 5: Root Cause Analysis Card (with Human Review & Citations) */}
      <div className="glass-panel p-6 space-y-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-800 pb-4">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-lg bg-indigo-500/20 text-indigo-300">
              <Sparkles className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-white tracking-tight">
                Stage 5: Root Cause Deduction & Evidence Citations
              </h2>
              <p className="text-xs text-slate-400">Powered by Strong Model deduction with strict evidence attribution</p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {editingField === 'root_cause' ? (
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  placeholder="Enter updated root cause..."
                  className="px-3 py-1 bg-slate-950 border border-slate-700 rounded text-xs text-white w-64"
                />
                <button
                  onClick={() => handleReviewAction('root_cause', 'edit')}
                  className="px-3 py-1 bg-indigo-600 hover:bg-indigo-500 text-white rounded text-xs font-semibold cursor-pointer"
                >
                  Save
                </button>
                <button onClick={() => setEditingField(null)} className="p-1 text-slate-400">
                  <X className="w-4 h-4" />
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <button
                  onClick={() => handleReviewAction('root_cause', 'approve')}
                  className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-300 border border-emerald-500/30 text-xs font-semibold cursor-pointer"
                >
                  <Check className="w-3.5 h-3.5" />
                  <span>Approve Root Cause</span>
                </button>
                <button
                  onClick={() => {
                    setEditingField('root_cause');
                    setEditValue(rootCauseAnalysis?.probable_root_cause || '');
                  }}
                  className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 text-xs font-semibold cursor-pointer"
                >
                  <Edit3 className="w-3.5 h-3.5" />
                  <span>Edit</span>
                </button>
              </div>
            )}

            {rootCauseAnalysis && (
              <div className="text-right">
                <span className="text-[10px] font-mono text-slate-400 block uppercase">Confidence</span>
                <span className="text-sm font-bold text-indigo-300 font-mono">
                  {(rootCauseAnalysis.confidence * 100).toFixed(0)}%
                </span>
              </div>
            )}
          </div>
        </div>

        {rootCauseAnalysis ? (
          <div className="space-y-5">
            {/* Probable root cause highlight */}
            <div className="p-4 rounded-xl bg-slate-950/80 border border-indigo-500/30">
              <span className="text-xs font-mono font-bold uppercase tracking-wider text-indigo-400 block mb-1">
                Probable Root Cause
              </span>
              <p className="text-sm font-semibold text-slate-100 leading-relaxed">
                {rootCauseAnalysis.probable_root_cause}
              </p>
              {rootCauseAnalysis.confidence_rationale && (
                <p className="text-xs text-slate-400 mt-2 border-t border-slate-800/80 pt-2 italic">
                  Rationale: {rootCauseAnalysis.confidence_rationale}
                </p>
              )}
            </div>

            {/* Cited Supporting Evidence (Traceable Links) */}
            {rootCauseAnalysis.supporting_evidence && rootCauseAnalysis.supporting_evidence.length > 0 && (
              <div>
                <span className="text-xs font-mono font-semibold uppercase tracking-wider text-slate-300 block mb-2">
                  Cited Supporting Evidence (Traceable Links to Ingestion Records)
                </span>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {rootCauseAnalysis.supporting_evidence.map((ev, i) => {
                    const isUncited = ev.status === 'uncited' || !ev.evidence_id;
                    const isKb = ev.evidence_id?.startsWith('KB-');
                    const isConfirmed = ev.evidence_id?.startsWith('CONFIRMED-');
                    const targetEvidence = getEvidenceById(ev.evidence_id);

                    return (
                      <div key={i} className="p-3.5 rounded-lg bg-slate-950/60 border border-slate-800 flex flex-col justify-between space-y-2">
                        <div className="text-xs font-mono text-slate-200 italic">
                          "{ev.quote}"
                        </div>
                        <div className="flex items-center justify-between text-[11px] font-mono pt-2 border-t border-slate-900">
                          <span className="text-slate-500">Source Anchor:</span>
                          {isUncited ? (
                            <span className="px-2 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30 flex items-center gap-1">
                              <AlertTriangle className="w-3 h-3 text-amber-400" />
                              (uncited claim)
                            </span>
                          ) : isConfirmed ? (
                            <span className="px-2 py-0.5 rounded bg-emerald-950 text-emerald-300 border border-emerald-800 flex items-center gap-1 font-bold">
                              <CheckCircle2 className="w-3 h-3 text-emerald-400" />
                              confirmed past incident ({ev.evidence_id})
                            </span>
                          ) : isKb ? (
                            <span className="px-2 py-0.5 rounded bg-indigo-950 text-indigo-300 border border-indigo-800 flex items-center gap-1">
                              <Link2 className="w-3 h-3 text-indigo-400" />
                              KB Reference ({ev.evidence_id})
                            </span>
                          ) : (
                            <a
                              href={`#ev-${ev.evidence_id}`}
                              className="px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-indigo-300 border border-indigo-500/30 flex items-center gap-1 transition-colors"
                            >
                              <Link2 className="w-3 h-3 text-indigo-400" />
                              {ev.evidence_id} ({targetEvidence?.type || 'evidence record'})
                            </a>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Alternative Hypotheses Evaluated */}
            {rootCauseAnalysis.alternative_hypotheses && rootCauseAnalysis.alternative_hypotheses.length > 0 && (
              <div>
                <span className="text-xs font-mono font-semibold uppercase tracking-wider text-slate-300 block mb-2">
                  Alternative Hypotheses Evaluated & Discounted
                </span>
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs border border-slate-800 rounded-lg overflow-hidden">
                    <thead className="bg-slate-950 text-slate-400 font-mono uppercase text-[10px]">
                      <tr>
                        <th className="p-2.5 border-b border-slate-800">Hypothesis</th>
                        <th className="p-2.5 border-b border-slate-800 w-24">Likelihood</th>
                        <th className="p-2.5 border-b border-slate-800">Reason Discounted</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/60 bg-slate-900/30 text-slate-300">
                      {rootCauseAnalysis.alternative_hypotheses.map((h, i) => (
                        <tr key={i}>
                          <td className="p-2.5 font-medium">{h.hypothesis}</td>
                          <td className="p-2.5 font-mono text-slate-400">{h.likelihood}</td>
                          <td className="p-2.5 text-slate-400">{h.reason_discounted}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Recommended Next Checks */}
            {rootCauseAnalysis.recommended_next_checks && rootCauseAnalysis.recommended_next_checks.length > 0 && (
              <div>
                <span className="text-xs font-mono font-semibold uppercase tracking-wider text-slate-300 block mb-2">
                  Recommended Immediate Verification Checks
                </span>
                <div className="space-y-1.5">
                  {rootCauseAnalysis.recommended_next_checks.map((check, i) => (
                    <div key={i} className="flex items-start gap-2 text-xs text-slate-300 bg-slate-950/40 p-2 rounded border border-slate-800/60">
                      <span className="text-indigo-400 font-bold font-mono">[{i + 1}]</span>
                      <span>{check}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="py-8 text-center text-xs font-mono text-slate-500">
            {incident.status === 'processing' ? 'Root cause reasoning stage running...' : 'No root cause record.'}
          </div>
        )}
      </div>

      {/* Audit History of Reviews */}
      {reviews && reviews.length > 0 && (
        <div className="glass-panel p-5 space-y-3">
          <div className="flex items-center gap-2 border-b border-slate-800 pb-2.5">
            <CheckCircle2 className="w-4 h-4 text-emerald-400" />
            <h3 className="text-xs font-bold text-white uppercase font-mono tracking-wider">
              Human Review & Triage History ({reviews.length})
            </h3>
          </div>
          <div className="divide-y divide-slate-800/60">
            {reviews.map((rev, i) => (
              <div key={i} className="py-2.5 flex items-center justify-between text-xs font-mono">
                <div className="flex items-center gap-2">
                  <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                    rev.action === 'approve' ? 'bg-emerald-950 text-emerald-300 border border-emerald-800' : 'bg-indigo-950 text-indigo-300 border border-indigo-800'
                  }`}>
                    {rev.action}
                  </span>
                  <span className="text-white font-semibold capitalize">{rev.field}:</span>
                  <span className="text-slate-400 line-through">{String(rev.old_value)}</span>
                  <span className="text-emerald-300 font-bold">→ {String(rev.new_value)}</span>
                </div>
                <div className="text-[11px] text-slate-500">
                  by {rev.reviewer} at {new Date(rev.timestamp).toLocaleTimeString()}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Stage 7: Writer Artifacts */}
      {writerAnalysis && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Bug Report */}
          <div className="glass-panel p-6 space-y-4">
            <div className="flex items-center gap-2 border-b border-slate-800 pb-3">
              <FileText className="w-4 h-4 text-indigo-400" />
              <h2 className="text-sm font-bold text-white uppercase font-mono tracking-wide">
                Structured Engineering Bug Report
              </h2>
            </div>

            <div className="space-y-3 text-xs">
              <div>
                <span className="text-slate-400 font-mono block text-[11px] uppercase">Title</span>
                <div className="text-white font-semibold text-sm">{writerAnalysis.bug_report.title}</div>
              </div>

              <div>
                <span className="text-slate-400 font-mono block text-[11px] uppercase">Suspected Component</span>
                <div className="font-mono text-indigo-300">{writerAnalysis.bug_report.suspected_component}</div>
              </div>

              <div>
                <span className="text-slate-400 font-mono block text-[11px] uppercase mb-1">Steps to Reproduce</span>
                <ol className="list-decimal list-inside space-y-1 text-slate-300 bg-slate-950/50 p-2.5 rounded border border-slate-800">
                  {writerAnalysis.bug_report.steps_to_reproduce.map((step, i) => (
                    <li key={i}>{step}</li>
                  ))}
                </ol>
              </div>

              <div className="grid grid-cols-2 gap-3 pt-1">
                <div className="bg-slate-950/50 p-2.5 rounded border border-slate-800">
                  <span className="text-slate-400 font-mono block text-[10px] uppercase mb-1">Expected Behavior</span>
                  <p className="text-slate-300 text-[11px]">{writerAnalysis.bug_report.expected}</p>
                </div>
                <div className="bg-slate-950/50 p-2.5 rounded border border-slate-800">
                  <span className="text-slate-400 font-mono block text-[10px] uppercase mb-1">Actual Behavior</span>
                  <p className="text-rose-300 text-[11px]">{writerAnalysis.bug_report.actual}</p>
                </div>
              </div>
            </div>
          </div>

          {/* Remediation & Executive Summary */}
          <div className="glass-panel p-6 space-y-4 flex flex-col justify-between">
            <div className="space-y-4">
              <div className="flex items-center gap-2 border-b border-slate-800 pb-3">
                <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                <h2 className="text-sm font-bold text-white uppercase font-mono tracking-wide">
                  Remediation & Executive Summary
                </h2>
              </div>

              {/* Fixes */}
              <div>
                <span className="text-xs font-mono font-semibold uppercase tracking-wider text-slate-300 block mb-2">
                  Actionable Technical Fixes
                </span>
                <div className="space-y-1.5">
                  {writerAnalysis.suggested_fixes.map((fix, i) => (
                    <div key={i} className="flex items-start gap-2 text-xs text-slate-200 bg-emerald-950/20 border border-emerald-800/40 p-2 rounded">
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0 mt-0.5" />
                      <span>{fix}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Executive Summary */}
              <div>
                <span className="text-xs font-mono font-semibold uppercase tracking-wider text-slate-300 block mb-1">
                  Executive Briefing
                </span>
                <p className="text-xs text-slate-300 bg-slate-950/60 p-3 rounded border border-slate-800 leading-relaxed">
                  {writerAnalysis.executive_summary}
                </p>
              </div>
            </div>

            <div className="pt-3 border-t border-slate-800 flex items-center justify-between text-xs text-slate-400">
              <span className="font-mono">Review Decision: Ready</span>
              <span className="text-emerald-400 font-semibold flex items-center gap-1">
                <CheckCircle2 className="w-3.5 h-3.5" /> Verified Output
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Raw Traceability Inspector */}
      <div className="glass-panel p-4">
        <button
          onClick={() => setShowRawJson(!showRawJson)}
          className="w-full flex items-center justify-between text-xs font-mono text-slate-400 hover:text-slate-200 transition-colors"
        >
          <div className="flex items-center gap-2">
            <Terminal className="w-4 h-4 text-indigo-400" />
            <span>Inspection Drawer: Raw Evidence ({evidence.length}) & Stage Analyses ({analyses.length})</span>
          </div>
          {showRawJson ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>

        {showRawJson && (
          <div className="mt-4 pt-3 border-t border-slate-800 space-y-4">
            <div>
              <span className="text-xs font-mono text-slate-400 block mb-1">Ingested Evidence Records:</span>
              <pre className="text-[11px] font-mono text-slate-300 bg-slate-950 p-3 rounded border border-slate-800 overflow-x-auto max-h-60">
                {JSON.stringify(evidence, null, 2)}
              </pre>
            </div>

            <div>
              <span className="text-xs font-mono text-slate-400 block mb-1">Analysis Audit Trail:</span>
              <pre className="text-[11px] font-mono text-slate-300 bg-slate-950 p-3 rounded border border-slate-800 overflow-x-auto max-h-60">
                {JSON.stringify(analyses, null, 2)}
              </pre>
            </div>
          </div>
        )}
      </div>

      {/* Resolve Incident Dialog Modal */}
      {showResolveModal && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="glass-panel max-w-lg w-full p-6 space-y-4 border border-emerald-500/40">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="w-5 h-5 text-emerald-400" />
                <h3 className="text-base font-bold text-white">Resolve Incident & Learning Loop</h3>
              </div>
              <button onClick={() => setShowResolveModal(false)} className="text-slate-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>

            <p className="text-xs text-slate-300">
              Please enter the confirmed root cause and technical fix. IncidentIQ will vectorize this case and feed it into the continuous learning retrieval pool.
            </p>

            <form onSubmit={handleResolveSubmit} className="space-y-3.5">
              <div>
                <label className="text-xs font-mono uppercase text-slate-400 block mb-1">Confirmed Root Cause *</label>
                <textarea
                  required
                  rows={3}
                  value={resolveRootCause}
                  onChange={(e) => setResolveRootCause(e.target.value)}
                  className="w-full p-2.5 rounded bg-slate-950 border border-slate-700 text-xs text-white focus:outline-none focus:border-emerald-500 font-mono"
                  placeholder="e.g. Postgres pool max_connections saturated under concurrent load"
                />
              </div>

              <div>
                <label className="text-xs font-mono uppercase text-slate-400 block mb-1">Confirmed Resolution / Fix *</label>
                <textarea
                  required
                  rows={2}
                  value={resolveFix}
                  onChange={(e) => setResolveFix(e.target.value)}
                  className="w-full p-2.5 rounded bg-slate-950 border border-slate-700 text-xs text-white focus:outline-none focus:border-emerald-500 font-mono"
                  placeholder="e.g. Tuned max_connections = 200 in postgresql.conf and enabled pool recycling"
                />
              </div>

              <div>
                <label className="text-xs font-mono uppercase text-slate-400 block mb-1">Symptoms (Optional)</label>
                <input
                  type="text"
                  value={resolveSymptoms}
                  onChange={(e) => setResolveSymptoms(e.target.value)}
                  className="w-full p-2 rounded bg-slate-950 border border-slate-700 text-xs text-white font-mono"
                  placeholder="e.g. ECONNREFUSED 127.0.0.1:5432"
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setShowResolveModal(false)}
                  className="px-4 py-2 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={resolving}
                  className="px-4 py-2 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold flex items-center gap-1.5 cursor-pointer shadow-md shadow-emerald-900/40"
                >
                  {resolving ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                  <span>{resolving ? 'Vectorizing...' : 'Confirm & Mark Resolved'}</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
