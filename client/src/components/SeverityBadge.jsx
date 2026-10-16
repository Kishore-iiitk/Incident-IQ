import React from 'react';

export default function SeverityBadge({ severity, className = '' }) {
  if (!severity) {
    return (
      <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-slate-800 text-slate-400 border border-slate-700 ${className}`}>
        Triage Pending
      </span>
    );
  }

  const configs = {
    P1: {
      bg: 'bg-rose-500/15 text-rose-300 border-rose-500/30 glow-p1',
      label: 'P1 - Critical Outage'
    },
    P2: {
      bg: 'bg-amber-500/15 text-amber-300 border-amber-500/30 glow-p2',
      label: 'P2 - Major Impairment'
    },
    P3: {
      bg: 'bg-indigo-500/15 text-indigo-300 border-indigo-500/30',
      label: 'P3 - Moderate'
    },
    P4: {
      bg: 'bg-slate-800 text-slate-300 border-slate-700',
      label: 'P4 - Minor / Low'
    }
  };

  const config = configs[severity] || configs.P4;

  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-bold border tracking-wide uppercase font-mono ${config.bg} ${className}`}>
      <span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse"></span>
      {severity}
    </span>
  );
}
