import React, { useState, useEffect } from 'react';
import { io } from 'socket.io-client';
import Navbar from './components/Navbar.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Submit from './pages/Submit.jsx';
import IncidentDetail from './pages/IncidentDetail.jsx';

export default function App() {
  const [activeTab, setActiveTab] = useState('dashboard');
  const [selectedIncidentId, setSelectedIncidentId] = useState(null);
  const [healthInfo, setHealthInfo] = useState(null);
  const [socket, setSocket] = useState(null);

  // Initialize Socket.IO connection
  useEffect(() => {
    // In dev, Vite proxies /socket.io to http://localhost:5000
    const newSocket = io('/', {
      transports: ['websocket', 'polling']
    });

    newSocket.on('connect', () => {
      console.log('[IncidentIQ Client] Connected to real-time telemetry stream:', newSocket.id);
    });

    setSocket(newSocket);

    return () => {
      newSocket.disconnect();
    };
  }, []);

  // Poll system health status
  const checkHealth = async () => {
    try {
      const res = await fetch('/health');
      if (res.ok) {
        const data = await res.json();
        setHealthInfo(data);
      }
    } catch {
      setHealthInfo({ database: 'disconnected', status: 'offline' });
    }
  };

  useEffect(() => {
    checkHealth();
    const interval = setInterval(checkHealth, 8000);
    return () => clearInterval(interval);
  }, []);

  const handleSelectIncident = (id) => {
    setSelectedIncidentId(id);
    setActiveTab('detail');
  };

  const handleIncidentCreated = (id) => {
    setSelectedIncidentId(id);
    setActiveTab('detail');
  };

  const handleBackToDashboard = () => {
    setActiveTab('dashboard');
    setSelectedIncidentId(null);
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans">
      <Navbar
        activeTab={activeTab}
        setActiveTab={(tab) => {
          setActiveTab(tab);
          if (tab !== 'detail') setSelectedIncidentId(null);
        }}
        healthInfo={healthInfo}
        isDemoMode={false} // Will dynamically reflect demo flag from incident analyses
      />

      <main className="flex-1">
        {activeTab === 'dashboard' && (
          <Dashboard
            onSelectIncident={handleSelectIncident}
            onNewIncident={() => setActiveTab('submit')}
          />
        )}

        {activeTab === 'submit' && (
          <Submit onIncidentCreated={handleIncidentCreated} />
        )}

        {activeTab === 'detail' && selectedIncidentId && (
          <IncidentDetail
            incidentId={selectedIncidentId}
            onBack={handleBackToDashboard}
            socket={socket}
          />
        )}
      </main>

      <footer className="border-t border-slate-900 py-6 text-center text-xs text-slate-500">
        <div className="max-w-7xl mx-auto px-4 flex flex-col sm:flex-row items-center justify-between gap-2">
          <div>IncidentIQ Autonomous Incident Response System • Phase 1 Text Slice</div>
          <div className="font-mono text-[11px] text-slate-600">
            Model: GEMINI_MODEL / GEMINI_MODEL_STRONG
          </div>
        </div>
      </footer>
    </div>
  );
}
