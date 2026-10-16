import React from 'react';
import { CheckCircle2, Loader2, AlertCircle, Circle, ArrowRight } from 'lucide-react';

export const PIPELINE_STAGES = [
  { id: 'text_processor', name: 'Text Processor', desc: 'Entities & Errors' },
  { id: 'fusion', name: 'Evidence Fusion', desc: 'Timeline Bundle' },
  { id: 'rag_retrieval', name: 'RAG Retrieval', desc: 'Past Incidents' },
  { id: 'triage', name: 'Triage Agent', desc: 'Severity & Scope' },
  { id: 'root_cause', name: 'Root Cause', desc: 'Evidence Citations' },
  { id: 'router', name: 'Team Router', desc: 'Ownership Matching' },
  { id: 'writer', name: 'Writer Agent', desc: 'Bug Report & Fixes' }
];

export default function StageProgress({ currentStage, completedStages = [], failedStage = null, errorMessage = null, analyses = [] }) {
  const getStageStatus = (stageId) => {
    if (failedStage === stageId) return 'failed';
    if (completedStages.includes(stageId)) return 'completed';
    if (currentStage === stageId) return 'running';
    return 'pending';
  };

  return (
    <div className="glass-panel p-5">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-sm font-bold uppercase tracking-wider text-slate-300 font-mono">
            Pipeline Progression Telemetry
          </h3>
          <p className="text-xs text-slate-400">7-Stage Autonomous Incident Processing Stream</p>
        </div>
        {currentStage && (
          <div className="flex items-center gap-2 px-2.5 py-1 rounded bg-cyan-950/60 border border-cyan-800 text-cyan-300 text-xs font-mono">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            <span>Active: {currentStage}</span>
          </div>
        )}
      </div>

      {/* Stepper container */}
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3">
        {PIPELINE_STAGES.map((stage, idx) => {
          const status = getStageStatus(stage.id);
          const stageAnalysis = analyses.find(a => a.stage === stage.id);

          let borderClass = 'border-slate-800 bg-slate-900/40 text-slate-500';
          let icon = <Circle className="w-4 h-4 text-slate-600" />;

          if (status === 'completed') {
            borderClass = 'border-emerald-500/40 bg-emerald-950/20 text-emerald-300';
            icon = <CheckCircle2 className="w-4 h-4 text-emerald-400" />;
          } else if (status === 'running') {
            borderClass = 'border-cyan-500/60 bg-cyan-950/30 text-cyan-300 glow-processing';
            icon = <Loader2 className="w-4 h-4 text-cyan-400 animate-spin" />;
          } else if (status === 'failed') {
            borderClass = 'border-rose-500/60 bg-rose-950/30 text-rose-300';
            icon = <AlertCircle className="w-4 h-4 text-rose-400" />;
          }

          return (
            <div
              key={stage.id}
              className={`p-3 rounded-lg border transition-all duration-300 flex flex-col justify-between ${borderClass}`}
            >
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-[10px] font-mono font-bold tracking-wider opacity-60">
                    STAGE 0{idx + 1}
                  </span>
                  {icon}
                </div>
                <div className="text-xs font-bold text-slate-200 truncate">{stage.name}</div>
                <div className="text-[11px] opacity-70 truncate">{stage.desc}</div>
              </div>

              {stageAnalysis && stageAnalysis.latency_ms > 0 && (
                <div className="mt-2 pt-1 border-t border-slate-800/60 text-[10px] font-mono text-slate-400 flex items-center justify-between">
                  <span>Latency</span>
                  <span className="text-indigo-300">{stageAnalysis.latency_ms}ms</span>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {failedStage && errorMessage && (
        <div className="mt-4 p-3 rounded-lg bg-rose-950/40 border border-rose-800 text-rose-200 text-xs flex items-start gap-2.5">
          <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
          <div>
            <span className="font-semibold">Pipeline Execution Terminated:</span> {errorMessage}
          </div>
        </div>
      )}
    </div>
  );
}
