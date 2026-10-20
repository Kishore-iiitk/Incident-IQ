import React, { useState, useEffect } from 'react';
import { ShieldAlert, AlertTriangle, CheckCircle2, Clock, Users, RefreshCw, Plus, Search, ChevronRight } from 'lucide-react';
import SeverityBadge from '../components/SeverityBadge.jsx';
import StatusBadge from '../components/StatusBadge.jsx';

const renderSourceBadge = (source) => {
  switch (source) {
    case 'reporter':
      return (
        <span
          key="reporter"
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono font-semibold bg-emerald-950/80 text-emerald-400 border border-emerald-800/80 shadow-sm"
          title="Detected by Express Error Reporter middleware"
        >
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
          Reporter
        </span>
      );
    case 'poller':
      return (
        <span
          key="poller"
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono font-semibold bg-amber-950/80 text-amber-400 border border-amber-800/80 shadow-sm"
          title="Detected by Health Poller probe"
        >
          <span className="w-1.5 h-1.5 rounded-full bg-amber-400"></span>
          Poller
        </span>
      );
    case 'log_watcher':
      return (
        <span
          key="log_watcher"
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono font-semibold bg-purple-950/80 text-purple-400 border border-purple-800/80 shadow-sm"
          title="Detected by Log Watcher stream tailer"
        >
          <span className="w-1.5 h-1.5 rounded-full bg-purple-400"></span>
          Log Watcher
        </span>
      );
    case 'user':
    case 'user_submission':
    default:
      return (
        <span
          key="user"
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono font-semibold bg-sky-950/80 text-sky-400 border border-sky-800/80 shadow-sm"
          title="User report"
        >
          <span className="w-1.5 h-1.5 rounded-full bg-sky-400"></span>
          User
        </span>
      );
  }
};

export default function Dashboard({ onSelectIncident, onNewIncident, socket }) {
  const [incidents, setIncidents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [filterSeverity, setFilterSeverity] = useState('ALL');

  const fetchIncidents = async () => {
    try {
      setLoading(true);
      const res = await fetch('/incidents');
      if (res.ok) {
        const data = await res.json();
        setIncidents(data);
      }
    } catch (err) {
      console.error('Failed to fetch incidents:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchIncidents();
  }, []);

  // Live Socket.IO synchronization for real-time incident updates without refresh
  useEffect(() => {
    if (!socket) return;

    const handleCreated = (newInc) => {
      setIncidents((prev) => {
        if (prev.some((i) => i._id === newInc._id)) return prev;
        return [newInc, ...prev];
      });
    };

    const handleUpdated = (updatedInc) => {
      setIncidents((prev) =>
        prev.map((i) => (i._id === updatedInc._id ? { ...i, ...updatedInc } : i))
      );
    };

    const handlePipelineCompleted = (payload) => {
      setIncidents((prev) =>
        prev.map((i) => {
          if (i._id === payload.incidentId) {
            return {
              ...i,
              status: payload.status || 'review',
              severity: payload.severity || i.severity,
              assigned_team: payload.assigned_team || i.assigned_team
            };
          }
          return i;
        })
      );
    };

    socket.on('incident:created', handleCreated);
    socket.on('incident:updated', handleUpdated);
    socket.on('pipeline:completed', handlePipelineCompleted);

    return () => {
      socket.off('incident:created', handleCreated);
      socket.off('incident:updated', handleUpdated);
      socket.off('pipeline:completed', handlePipelineCompleted);
    };
  }, [socket]);

  // Filtered list
  const filtered = incidents.filter((inc) => {
    const matchesSearch =
      inc.title?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      inc.description?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      inc.assigned_team?.toLowerCase().includes(searchTerm.toLowerCase());

    const matchesSeverity =
      filterSeverity === 'ALL' || inc.severity === filterSeverity;

    return matchesSearch && matchesSeverity;
  });

  const p1p2Count = incidents.filter(i => i.severity === 'P1' || i.severity === 'P2').length;
  const processingCount = incidents.filter(i => i.status === 'processing').length;
  const reviewCount = incidents.filter(i => i.status === 'review').length;

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      {/* Top Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-8">
        <div>
          <h1 className="text-2xl sm:text-3xl font-extrabold text-white tracking-tight">
            Incident Operations Center
          </h1>
          <p className="text-slate-400 text-sm mt-1">
            Real-time telemetry and autonomous diagnosis stream for active system anomalies
          </p>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={fetchIncidents}
            className="p-2.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-slate-300 border border-slate-800 transition-all cursor-pointer"
            title="Refresh Incidents"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>

          <button
            onClick={onNewIncident}
            className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-sm shadow-md shadow-indigo-600/30 transition-all cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            <span>New Incident</span>
          </button>
        </div>
      </div>

      {/* Metric Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <div className="glass-panel p-4 flex items-center gap-3.5">
          <div className="p-3 rounded-xl bg-indigo-500/15 text-indigo-400 border border-indigo-500/20">
            <ShieldAlert className="w-5 h-5" />
          </div>
          <div>
            <div className="text-2xl font-bold text-white font-mono">{incidents.length}</div>
            <div className="text-xs text-slate-400 font-medium">Total Ingested</div>
          </div>
        </div>

        <div className="glass-panel p-4 flex items-center gap-3.5">
          <div className="p-3 rounded-xl bg-cyan-500/15 text-cyan-400 border border-cyan-500/20">
            <Clock className="w-5 h-5" />
          </div>
          <div>
            <div className="text-2xl font-bold text-white font-mono">{processingCount}</div>
            <div className="text-xs text-slate-400 font-medium">Pipeline Active</div>
          </div>
        </div>

        <div className="glass-panel p-4 flex items-center gap-3.5">
          <div className="p-3 rounded-xl bg-emerald-500/15 text-emerald-400 border border-emerald-500/20">
            <CheckCircle2 className="w-5 h-5" />
          </div>
          <div>
            <div className="text-2xl font-bold text-white font-mono">{reviewCount}</div>
            <div className="text-xs text-slate-400 font-medium">Ready For Review</div>
          </div>
        </div>

        <div className="glass-panel p-4 flex items-center gap-3.5">
          <div className="p-3 rounded-xl bg-amber-500/15 text-amber-400 border border-amber-500/20">
            <AlertTriangle className="w-5 h-5" />
          </div>
          <div>
            <div className="text-2xl font-bold text-amber-300 font-mono">{p1p2Count}</div>
            <div className="text-xs text-slate-400 font-medium">P1 / P2 Major Outages</div>
          </div>
        </div>
      </div>

      {/* Filters and Search */}
      <div className="glass-panel p-3.5 mb-6 flex flex-col sm:flex-row items-center justify-between gap-3">
        <div className="relative w-full sm:w-80">
          <Search className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            placeholder="Search incident title, team, text..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full pl-9 pr-3 py-1.5 rounded-lg bg-slate-950/70 border border-slate-800 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-indigo-500 transition-all"
          />
        </div>

        <div className="flex items-center gap-1.5 w-full sm:w-auto overflow-x-auto pb-1 sm:pb-0">
          {['ALL', 'P1', 'P2', 'P3', 'P4'].map((sev) => (
            <button
              key={sev}
              onClick={() => setFilterSeverity(sev)}
              className={`px-3 py-1 rounded-md text-xs font-mono font-semibold transition-all ${
                filterSeverity === sev
                  ? 'bg-slate-800 text-white border border-slate-700 shadow-sm'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {sev}
            </button>
          ))}
        </div>
      </div>

      {/* Incident List */}
      {loading ? (
        <div className="glass-panel p-12 text-center text-slate-400 flex flex-col items-center justify-center gap-3">
          <RefreshCw className="w-6 h-6 animate-spin text-indigo-400" />
          <span className="text-sm font-mono">Synchronizing incident database...</span>
        </div>
      ) : filtered.length === 0 ? (
        <div className="glass-panel p-12 text-center text-slate-400 flex flex-col items-center justify-center gap-3">
          <ShieldAlert className="w-10 h-10 text-slate-600" />
          <div className="text-base font-semibold text-slate-300">No Incidents Found</div>
          <p className="text-xs text-slate-500 max-w-sm">
            No incident records match the filter criteria. Submit a new system outage to trigger the autonomous response pipeline.
          </p>
          <button
            onClick={onNewIncident}
            className="mt-2 px-4 py-2 rounded-lg bg-indigo-600 text-white text-xs font-semibold hover:bg-indigo-500 cursor-pointer"
          >
            Submit Incident
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3.5">
          {filtered.map((inc) => (
            <div
              key={inc._id}
              onClick={() => onSelectIncident(inc._id)}
              className="glass-panel glass-panel-hover p-4 sm:p-5 cursor-pointer flex flex-col md:flex-row md:items-center justify-between gap-4"
            >
              <div className="space-y-2 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <SeverityBadge severity={inc.severity} />
                  <StatusBadge status={inc.status} />

                  {/* Auto-detected vs User-submitted flag */}
                  {inc.sources && inc.sources.some(s => ['reporter', 'poller', 'log_watcher'].includes(s)) ? (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono font-bold tracking-wide bg-rose-500/15 text-rose-300 border border-rose-500/30">
                      ⚡ AUTO-DETECTED
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono font-semibold tracking-wide bg-slate-800/80 text-slate-400 border border-slate-700">
                      USER REPORT
                    </span>
                  )}

                  {/* Source Badges */}
                  {inc.sources && inc.sources.length > 0 && (
                    <div className="flex items-center gap-1">
                      {Array.from(new Set(inc.sources)).map(renderSourceBadge)}
                    </div>
                  )}

                  {/* Affected Users Count */}
                  {inc.affected_users !== null && inc.affected_users !== undefined && (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-mono bg-cyan-950/60 text-cyan-300 border border-cyan-800/60" title="Impacted Users">
                      <Users className="w-3 h-3 text-cyan-400" />
                      <span>{inc.affected_users} affected</span>
                    </span>
                  )}

                  {inc.assigned_team && (
                    <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded text-xs font-mono bg-slate-800 text-slate-300 border border-slate-700">
                      <Users className="w-3 h-3 text-indigo-400" />
                      <span>{inc.assigned_team}</span>
                    </span>
                  )}
                  <span className="text-[11px] font-mono text-slate-500 ml-auto md:ml-0">
                    ID: {inc._id.substring(inc._id.length - 8)}
                  </span>
                </div>

                <h3 className="text-base font-bold text-white group-hover:text-indigo-300 transition-colors">
                  {inc.title}
                </h3>

                <p className="text-xs text-slate-400 line-clamp-2">
                  {inc.description}
                </p>

                {inc.affected_systems && inc.affected_systems.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5 pt-1">
                    <span className="text-[10px] font-mono uppercase text-slate-500">Affected:</span>
                    {inc.affected_systems.map((sys, idx) => (
                      <span
                        key={idx}
                        className="px-2 py-0.5 rounded text-[10px] font-mono bg-slate-950/80 text-slate-300 border border-slate-800"
                      >
                        {sys}
                      </span>
                    ))}
                  </div>
                )}
              </div>

              <div className="flex md:flex-col items-end justify-between md:justify-center border-t md:border-t-0 md:border-l border-slate-800/80 pt-3 md:pt-0 md:pl-6 shrink-0 gap-1">
                <span className="text-[11px] font-mono text-slate-400">
                  {new Date(inc.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
                <span className="text-[10px] text-slate-500">
                  {new Date(inc.created_at).toLocaleDateString()}
                </span>
                <div className="hidden md:flex items-center gap-1 text-xs text-indigo-400 font-semibold mt-2">
                  <span>Inspect</span>
                  <ChevronRight className="w-3.5 h-3.5" />
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
