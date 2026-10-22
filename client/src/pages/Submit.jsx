import React, { useState } from 'react';
import { Send, Sparkles, AlertCircle, FileText, ArrowRight, ShieldAlert, Upload, FileCode, Image, Mic, Mail, X } from 'lucide-react';
import { createIncident } from '../api.js';

const SAMPLE_INCIDENT_TEXT = "Students cannot open assignment pages since 2pm, the course page shows a 500 error and the upload button spins forever.";

export default function Submit({ onIncidentCreated }) {
  const [text, setText] = useState('');
  const [title, setTitle] = useState('');
  const [files, setFiles] = useState({
    log: null,
    image: null,
    audio: null,
    emails: []
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const handleFileChange = (type, e) => {
    const selected = e.target.files;
    if (!selected || selected.length === 0) return;

    if (type === 'log') {
      const file = selected[0];
      if (file.size > 5 * 1024 * 1024) {
        setError(`Log file "${file.name}" exceeds 5 MB limit`);
        return;
      }
      setFiles(prev => ({ ...prev, log: file }));
      setError(null);
    } else if (type === 'image') {
      const file = selected[0];
      if (file.size > 5 * 1024 * 1024) {
        setError(`Screenshot "${file.name}" exceeds 5 MB limit`);
        return;
      }
      setFiles(prev => ({ ...prev, image: file }));
      setError(null);
    } else if (type === 'audio') {
      const file = selected[0];
      if (file.size > 10 * 1024 * 1024) {
        setError(`Audio note "${file.name}" exceeds 10 MB limit`);
        return;
      }
      setFiles(prev => ({ ...prev, audio: file }));
      setError(null);
    } else if (type === 'emails') {
      const newEmails = Array.from(selected);
      for (const ef of newEmails) {
        if (ef.size > 5 * 1024 * 1024) {
          setError(`Email file "${ef.name}" exceeds 5 MB limit`);
          return;
        }
      }
      setFiles(prev => ({ ...prev, emails: [...prev.emails, ...newEmails] }));
      setError(null);
    }
  };

  const removeFile = (type, index = null) => {
    if (type === 'emails' && index !== null) {
      setFiles(prev => ({
        ...prev,
        emails: prev.emails.filter((_, i) => i !== index)
      }));
    } else {
      setFiles(prev => ({ ...prev, [type]: null }));
    }
  };

  const handleSubmit = async (e) => {
    if (e) e.preventDefault();
    const hasFiles = files.log || files.image || files.audio || files.emails.length > 0;
    if (!text.trim() && !hasFiles) {
      setError('Please provide an incident description or attach evidence files (log, image, audio, or email).');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      let result;

      if (hasFiles) {
        // Send multipart form-data
        const formData = new FormData();
        if (text.trim()) formData.append('text', text.trim());
        if (title.trim()) formData.append('title', title.trim());
        formData.append('source', 'user_submission');

        if (files.log) formData.append('log', files.log);
        if (files.image) formData.append('screenshot', files.image);
        if (files.audio) formData.append('voice', files.audio);
        for (const ef of files.emails) {
          formData.append('email', ef);
        }

        result = await createIncident(formData, true);
      } else {
        // Text-only JSON submission
        result = await createIncident({
          text: text.trim(),
          title: title.trim() || undefined,
          source: 'user_submission'
        });
      }

      onIncidentCreated(result.id);
    } catch (err) {
      console.error('Submission failed:', err);
      setError(err.message || 'Failed to submit incident');
      setLoading(false);
    }
  };

  const handleUsePreset = () => {
    setText(SAMPLE_INCIDENT_TEXT);
    setTitle('LMS Assignment Upload & 500 Error Outage');
    setError(null);
  };

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <div className="mb-8">
        <div className="flex items-center gap-2 text-indigo-400 text-xs font-mono font-semibold uppercase tracking-wider mb-2">
          <ShieldAlert className="w-4 h-4" />
          <span>Multimodal Incident Ingestion Portal</span>
        </div>
        <h1 className="text-3xl font-extrabold text-white tracking-tight">
          Report System Outage or Anomaly
        </h1>
        <p className="text-slate-400 mt-2 text-sm max-w-2xl">
          Submit free-form outage notices or attach multimodal evidence (server logs, error screenshots, audio voice notes, user complaint emails). IncidentIQ automatically parses evidence, extracts templates, fuses timelines, and authors structured bug reports.
        </p>
      </div>

      {/* Preset Banner */}
      <div className="mb-6 p-4 rounded-xl bg-gradient-to-r from-indigo-950/40 via-slate-900 to-slate-900 border border-indigo-500/30 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="p-2 rounded-lg bg-indigo-500/20 text-indigo-300 mt-0.5">
            <Sparkles className="w-5 h-5" />
          </div>
          <div>
            <div className="text-sm font-semibold text-slate-200">Phase 1 Benchmark Outage Preset</div>
            <div className="text-xs text-slate-400 font-mono mt-0.5 line-clamp-1">
              "{SAMPLE_INCIDENT_TEXT}"
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={handleUsePreset}
          className="shrink-0 px-3.5 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold shadow-md shadow-indigo-600/20 transition-all flex items-center gap-1.5 justify-center"
        >
          <span>Load Preset</span>
          <ArrowRight className="w-3.5 h-3.5" />
        </button>
      </div>

      {error && (
        <div className="mb-6 p-4 rounded-xl bg-rose-950/40 border border-rose-800 text-rose-200 text-sm flex items-center gap-3">
          <AlertCircle className="w-5 h-5 text-rose-400 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Submission Form */}
      <form onSubmit={handleSubmit} className="glass-panel p-6 sm:p-8 space-y-6">
        <div>
          <label className="block text-xs font-mono font-semibold uppercase tracking-wider text-slate-300 mb-2">
            Incident Title <span className="text-slate-500 font-normal">(Optional - will be auto-generated by AI if blank)</span>
          </label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. LMS Assignment 500 Server Error"
            className="w-full px-4 py-2.5 rounded-lg bg-slate-950/60 border border-slate-800 text-slate-100 placeholder-slate-600 text-sm focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-all"
          />
        </div>

        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="block text-xs font-mono font-semibold uppercase tracking-wider text-slate-300">
              Raw Incident Narrative or Logs <span className="text-slate-500 font-normal">(Required if no files attached)</span>
            </label>
            <span className="text-[11px] font-mono text-slate-500">
              {text.length} characters
            </span>
          </div>
          <textarea
            rows={5}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Describe what occurred, error messages observed, affected users, or paste log snippets..."
            className="w-full px-4 py-3 rounded-lg bg-slate-950/60 border border-slate-800 text-slate-100 placeholder-slate-600 text-sm font-mono focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-all resize-y"
          />
        </div>

        {/* Multimodal File Uploads Section */}
        <div className="space-y-3 pt-2">
          <label className="block text-xs font-mono font-semibold uppercase tracking-wider text-slate-300">
            Multimodal Evidence Attachments <span className="text-slate-500 font-normal">(Optional)</span>
          </label>

          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3">
            {/* Server Log Upload */}
            <div className="p-3.5 rounded-lg bg-slate-950/50 border border-slate-800 hover:border-slate-700 transition-all flex flex-col justify-between">
              <div className="flex items-center gap-2 mb-2 text-indigo-400">
                <FileCode className="w-4 h-4" />
                <span className="text-xs font-mono font-semibold">Server Log</span>
              </div>
              <p className="text-[11px] text-slate-500 mb-2">.log files (max 5 MB)</p>
              {files.log ? (
                <div className="flex items-center justify-between bg-indigo-950/40 border border-indigo-800/60 px-2 py-1.5 rounded text-xs text-indigo-200">
                  <span className="truncate max-w-[120px] font-mono text-[11px]">{files.log.name}</span>
                  <button type="button" onClick={() => removeFile('log')} className="text-slate-400 hover:text-rose-400">
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              ) : (
                <label className="cursor-pointer text-center px-2 py-1.5 rounded bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-300 text-xs font-mono transition-all">
                  <span>Browse .log</span>
                  <input
                    type="file"
                    accept=".log,text/plain"
                    className="hidden"
                    onChange={(e) => handleFileChange('log', e)}
                  />
                </label>
              )}
            </div>

            {/* Screenshot Upload */}
            <div className="p-3.5 rounded-lg bg-slate-950/50 border border-slate-800 hover:border-slate-700 transition-all flex flex-col justify-between">
              <div className="flex items-center gap-2 mb-2 text-indigo-400">
                <Image className="w-4 h-4" />
                <span className="text-xs font-mono font-semibold">Screenshot</span>
              </div>
              <p className="text-[11px] text-slate-500 mb-2">.png, .jpg (max 5 MB)</p>
              {files.image ? (
                <div className="flex items-center justify-between bg-indigo-950/40 border border-indigo-800/60 px-2 py-1.5 rounded text-xs text-indigo-200">
                  <span className="truncate max-w-[120px] font-mono text-[11px]">{files.image.name}</span>
                  <button type="button" onClick={() => removeFile('image')} className="text-slate-400 hover:text-rose-400">
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              ) : (
                <label className="cursor-pointer text-center px-2 py-1.5 rounded bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-300 text-xs font-mono transition-all">
                  <span>Browse Image</span>
                  <input
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => handleFileChange('image', e)}
                  />
                </label>
              )}
            </div>

            {/* Voice Note Upload */}
            <div className="p-3.5 rounded-lg bg-slate-950/50 border border-slate-800 hover:border-slate-700 transition-all flex flex-col justify-between">
              <div className="flex items-center gap-2 mb-2 text-indigo-400">
                <Mic className="w-4 h-4" />
                <span className="text-xs font-mono font-semibold">Voice Note</span>
              </div>
              <p className="text-[11px] text-slate-500 mb-2">.m4a, .mp3, .wav (max 10 MB)</p>
              {files.audio ? (
                <div className="flex items-center justify-between bg-indigo-950/40 border border-indigo-800/60 px-2 py-1.5 rounded text-xs text-indigo-200">
                  <span className="truncate max-w-[120px] font-mono text-[11px]">{files.audio.name}</span>
                  <button type="button" onClick={() => removeFile('audio')} className="text-slate-400 hover:text-rose-400">
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              ) : (
                <label className="cursor-pointer text-center px-2 py-1.5 rounded bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-300 text-xs font-mono transition-all">
                  <span>Browse Audio</span>
                  <input
                    type="file"
                    accept="audio/*,.m4a"
                    className="hidden"
                    onChange={(e) => handleFileChange('audio', e)}
                  />
                </label>
              )}
            </div>

            {/* Email Complaints Upload */}
            <div className="p-3.5 rounded-lg bg-slate-950/50 border border-slate-800 hover:border-slate-700 transition-all flex flex-col justify-between">
              <div className="flex items-center gap-2 mb-2 text-indigo-400">
                <Mail className="w-4 h-4" />
                <span className="text-xs font-mono font-semibold">Emails</span>
              </div>
              <p className="text-[11px] text-slate-500 mb-2">.txt, .eml (max 5 MB)</p>
              {files.emails.length > 0 ? (
                <div className="space-y-1">
                  {files.emails.map((ef, idx) => (
                    <div key={idx} className="flex items-center justify-between bg-indigo-950/40 border border-indigo-800/60 px-2 py-1 rounded text-xs text-indigo-200">
                      <span className="truncate max-w-[110px] font-mono text-[10px]">{ef.name}</span>
                      <button type="button" onClick={() => removeFile('emails', idx)} className="text-slate-400 hover:text-rose-400">
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                  <label className="cursor-pointer block text-center text-[10px] text-indigo-400 hover:underline pt-1">
                    <span>+ Add More</span>
                    <input
                      type="file"
                      accept=".txt,.eml"
                      multiple
                      className="hidden"
                      onChange={(e) => handleFileChange('emails', e)}
                    />
                  </label>
                </div>
              ) : (
                <label className="cursor-pointer text-center px-2 py-1.5 rounded bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-300 text-xs font-mono transition-all">
                  <span>Browse Emails</span>
                  <input
                    type="file"
                    accept=".txt,.eml"
                    multiple
                    className="hidden"
                    onChange={(e) => handleFileChange('emails', e)}
                  />
                </label>
              )}
            </div>
          </div>
        </div>

        <div className="pt-2 flex items-center justify-between border-t border-slate-800">
          <div className="flex items-center gap-2 text-xs text-slate-400">
            <span className="w-2 h-2 rounded-full bg-emerald-400"></span>
            <span>Deterministic PII / secret redaction active before model processing</span>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="px-6 py-2.5 rounded-lg bg-gradient-to-r from-indigo-600 to-indigo-500 hover:from-indigo-500 hover:to-indigo-400 text-white font-semibold text-sm shadow-lg shadow-indigo-600/30 flex items-center gap-2 transition-all disabled:opacity-50 cursor-pointer"
          >
            <Send className="w-4 h-4" />
            <span>{loading ? 'Ingesting...' : 'Ingest & Start Analysis'}</span>
          </button>
        </div>
      </form>
    </div>
  );
}
