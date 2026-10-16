import React from 'react';
import { Loader2, CheckCircle2, AlertTriangle, AlertCircle, Clock } from 'lucide-react';

export default function StatusBadge({ status, className = '' }) {
  const configs = {
    detected: {
      bg: 'bg-yellow-500/10 text-yellow-300 border-yellow-500/30',
      icon: Clock,
      label: 'Detected'
    },
    processing: {
      bg: 'bg-cyan-500/15 text-cyan-300 border-cyan-500/40 glow-processing',
      icon: Loader2,
      spin: true,
      label: 'Pipeline Running'
    },
    review: {
      bg: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
      icon: CheckCircle2,
      label: 'Ready for Review'
    },
    resolved: {
      bg: 'bg-blue-500/15 text-blue-300 border-blue-500/30',
      icon: CheckCircle2,
      label: 'Resolved'
    },
    failed: {
      bg: 'bg-rose-500/15 text-rose-300 border-rose-500/30',
      icon: AlertCircle,
      label: 'Pipeline Failed'
    }
  };

  const config = configs[status] || configs.detected;
  const Icon = config.icon;

  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold border ${config.bg} ${className}`}>
      <Icon className={`w-3.5 h-3.5 ${config.spin ? 'animate-spin' : ''}`} />
      <span>{config.label}</span>
    </span>
  );
}
