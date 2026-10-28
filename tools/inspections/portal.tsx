import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import {
  MapPin, Truck, AlertTriangle, BarChart2, Award, ClipboardList, Radio, Crosshair, Plus, Trash2, Phone, Building2, X
} from 'lucide-react';
import {
  LEVELS, THROUGH, FETCHED_AT, COVERAGE, LAST_12, PORTS, PORT_TREND, PORTS_LAST_12, TOWNS, STATE_LAST_12, monthLabel
} from './cdot-data';

const fmt = n => (n ?? 0).toLocaleString('en-US');
const pct = r => (r == null ? '–' : `${(r * 100).toFixed(1)}%`);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const PERIOD = `${monthLabel(LAST_12[0], true)} – ${monthLabel(THROUGH, true)}`;

// Live open/closed status from this app's /api/stations (same origin, so the team sign-in covers it).
const STATUS_STYLE = {
  open: { ring: '#10B981', label: 'Open', cls: 'bg-emerald-950 text-emerald-400 border-emerald-800' },
  closed: { ring: '#EF4444', label: 'Closed', cls: 'bg-red-950 text-red-400 border-red-800' },
  planned: { ring: '#F59E0B', label: 'Planned', cls: 'bg-amber-950 text-amber-400 border-amber-800' },
  unknown: { ring: '#64748B', label: 'Status unknown', cls: 'bg-slate-800 text-slate-400 border-slate-700' },
};
const portStatus = (port, live) => (port.planned ? 'planned' : live?.[port.id]?.status || 'unknown');

// Leaflet map: ports of entry, towns sized by inspections, and this session's spotted pins.
const InspectionMap = ({ ports, towns, pins, liveStatus, selected, onSelect, isDropPinMode, onMapClickForPin }) => {
  const mapRef = useRef(null);
  const leafletInstance = useRef(null);
  const layerRef = useRef(null);
  const [mapReady, setMapReady] = useState(false);

  useEffect(() => {
    if (!document.getElementById('leaflet-css')) {
      const link = document.createElement('link');
      link.id = 'leaflet-css';
      link.rel = 'stylesheet';
      link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
      document.head.appendChild(link);
    }
    const initMap = () => {
      if (window.L && mapRef.current && !leafletInstance.current) {
        const map = window.L.map(mapRef.current, { zoomControl: false }).setView([39.0, -105.55], 7);
        window.L.control.zoom({ position: 'bottomright' }).addTo(map);
        window.L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
          attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
          maxZoom: 19
        }).addTo(map);
        layerRef.current = window.L.layerGroup().addTo(map);
        leafletInstance.current = map;
        setMapReady(true);
      }
    };
    if (window.L) initMap();
    else {
      const script = document.createElement('script');
      script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
      script.onload = initMap;
      document.head.appendChild(script);
    }
    return () => {
      if (leafletInstance.current) { leafletInstance.current.remove(); leafletInstance.current = null; }
    };
  }, []);

  useEffect(() => {
    if (!leafletInstance.current) return;
    const map = leafletInstance.current;
    const handleMapClick = (e) => { if (isDropPinMode) onMapClickForPin({ lat: e.latlng.lat, lng: e.latlng.lng }); };
    map.on('click', handleMapClick);
    return () => { map.off('click', handleMapClick); };
  }, [mapReady, isDropPinMode, onMapClickForPin]);

  useEffect(() => {
    if (!layerRef.current || !window.L) return;
    const L = window.L, layer = layerRef.current;
    layer.clearLayers();

    // Towns: circle area tracks the 12-month count for the chosen level.
    const max = Math.max(1, ...towns.map(t => t.count));
    towns.forEach(t => {
      const isSel = selected?.id === t.id;
      L.circleMarker([t.lat, t.lng], {
        radius: 3 + 20 * Math.sqrt(t.count / max),
        color: isSel ? '#f8fafc' : '#0891b2', weight: isSel ? 2.5 : 1,
        fillColor: '#22d3ee', fillOpacity: isSel ? 0.7 : 0.4
      })
        .bindTooltip(`<b>${esc(t.name)}</b><br>${fmt(t.count)} inspections, last 12 months`)
        .on('click', () => onSelect(t))
        .addTo(layer);
    });

    // Ports of entry: red, ringed by live status.
    ports.forEach(p => {
      const isSel = selected?.id === p.id, size = isSel ? 26 : 20;
      const ring = STATUS_STYLE[portStatus(p, liveStatus)].ring;
      L.marker([p.lat, p.lng], {
        zIndexOffset: 1000,
        icon: L.divIcon({
          className: '',
          html: `<div style="width:${size}px;height:${size}px;border-radius:50%;background:#dc2626;border:3px solid ${ring};box-shadow:0 0 10px #000a;cursor:pointer"></div>`,
          iconSize: [size, size], iconAnchor: [size / 2, size / 2]
        })
      })
        .bindTooltip(`<b>${esc(p.name)} port of entry</b><br>${esc(p.highway)} · ${fmt(p.last12.total)} inspections, last 12 months`)
        .on('click', () => onSelect(p))
        .addTo(layer);
    });

    // Spotted pins from this session.
    pins.forEach(pin => {
      const isSel = selected?.id === pin.id, size = isSel ? 30 : 24;
      L.marker([pin.lat, pin.lng], {
        zIndexOffset: 2000,
        icon: L.divIcon({
          className: '',
          html: `<div style="width:${size}px;height:${size}px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);background:#18181b;border:2.5px solid #EC4899;box-shadow:0 0 12px #EC4899b0;cursor:pointer"></div>`,
          iconSize: [size, size], iconAnchor: [size / 2, size]
        })
      })
        .bindTooltip(`<b>${esc(pin.title)}</b><br>Spotted ${esc(pin.time)}`)
        .on('click', () => onSelect(pin))
        .addTo(layer);
    });
  }, [mapReady, ports, towns, pins, liveStatus, selected, onSelect]);

  useEffect(() => {
    if (mapReady && selected) leafletInstance.current.flyTo([selected.lat, selected.lng], Math.max(leafletInstance.current.getZoom(), 9), { duration: 1 });
  }, [mapReady, selected?.id]);

  return (
    <div className="relative w-full h-full rounded-xl overflow-hidden border border-slate-700/60 shadow-2xl">
      <div ref={mapRef} className={`w-full h-full bg-slate-950 z-0 ${isDropPinMode ? 'cursor-crosshair' : ''}`} />
      {isDropPinMode && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-[500] bg-pink-950/90 text-pink-200 border border-pink-500/60 px-4 py-2 rounded-full shadow-2xl flex items-center gap-2 text-xs font-bold whitespace-nowrap">
          <Crosshair className="w-4 h-4 text-pink-400" />
          Tap the map where you saw it
        </div>
      )}
      <div className="absolute top-3 right-3 z-[400] bg-slate-900/90 p-3 rounded-xl border border-slate-700/60 shadow-2xl text-[11px] space-y-1.5 text-slate-300 max-w-[200px]">
        <div className="flex items-center gap-2"><span className="w-3 h-3 rounded-full bg-red-600 border-2 border-slate-500"></span>Port of entry (ring = status)</div>
        <div className="flex items-center gap-2"><span className="w-3 h-3 rounded-full bg-cyan-400/50 border border-cyan-600"></span>Town: bigger = more inspections</div>
        <div className="flex items-center gap-2"><span className="w-3 h-3 rounded-full bg-zinc-900 border-2 border-pink-500"></span>Spotted today (this tab only)</div>
      </div>
    </div>
  );
};

// Monthly bars with an optional out-of-service-rate line on top.
const MonthlyChart = ({ months, title }) => {
  const W = 600, H = 160, pad = 18;
  const max = Math.max(1, ...months.map(m => m.total));
  const bw = (W - pad * 2) / months.length;
  const rates = months.map(m => m.vehicleOosRate).filter(r => r != null);
  const rmax = Math.max(0.01, ...rates);
  const line = months.map((m, i) => m.vehicleOosRate == null ? null :
    `${pad + bw * i + bw / 2},${H - pad - (m.vehicleOosRate / rmax) * (H - pad * 2)}`).filter(Boolean).join(' ');
  const every = Math.ceil(months.length / 8);
  return (
    <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-4 shadow-xl">
      <div className="flex flex-wrap justify-between gap-2 mb-2 text-xs">
        <span className="text-slate-300 font-semibold">{title}</span>
        <span className="flex items-center gap-3 text-slate-400">
          <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 bg-cyan-500 rounded-sm"></span>Inspections</span>
          <span className="flex items-center gap-1"><span className="w-3 h-0.5 bg-red-400"></span>Vehicle OOS rate</span>
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H + 14}`} className="w-full h-auto" role="img" aria-label={title}>
        {months.map((m, i) => {
          const h = (m.total / max) * (H - pad * 2), partial = m.month === THROUGH;
          return (
            <g key={m.month}>
              <rect x={pad + bw * i + 1} y={H - pad - h} width={Math.max(1, bw - 2)} height={h} rx="1.5"
                fill={partial ? '#155e75' : '#06b6d4'}>
                <title>{`${monthLabel(m.month, true)}${partial ? ' (partial)' : ''}: ${fmt(m.total)} inspections, vehicle OOS ${pct(m.vehicleOosRate)}`}</title>
              </rect>
              {i % every === 0 && <text x={pad + bw * i + bw / 2} y={H + 8} textAnchor="middle" fontSize="10" fill="#64748b">{monthLabel(m.month)}{m.month.endsWith('01') ? ` ${m.month.slice(2, 4)}` : ''}</text>}
            </g>
          );
        })}
        <polyline points={line} fill="none" stroke="#f87171" strokeWidth="2" strokeLinejoin="round" />
      </svg>
      <p className="text-[10px] text-slate-500 mt-1">Line is scaled to its own range (peak {pct(rmax)}). {monthLabel(THROUGH)} is a partial month (darker bar).</p>
    </div>
  );
};

const LevelBars = ({ byLevel }) => {
  const entries = Object.entries(byLevel).filter(([, n]) => n > 0).sort(([a], [b]) => a - b);
  const max = Math.max(1, ...entries.map(([, n]) => n));
  if (!entries.length) return <p className="text-xs text-slate-500">No inspections in this period.</p>;
  return (
    <div className="space-y-1.5">
      {entries.map(([lv, n]) => (
        <div key={lv} className="text-xs">
          <div className="flex justify-between text-slate-400"><span>Level {lv} · {LEVELS[lv] || ''}</span><span className="font-mono text-slate-200">{fmt(n)}</span></div>
          <div className="h-1.5 bg-slate-800 rounded"><div className="h-1.5 bg-cyan-500 rounded" style={{ width: `${(n / max) * 100}%` }}></div></div>
        </div>
      ))}
    </div>
  );
};

const Stat = ({ label, value, sub, tone = 'text-slate-100' }) => (
  <div className="bg-slate-950 p-2.5 rounded-lg border border-slate-800 min-w-0">
    <div className="text-[10px] text-slate-400">{label}</div>
    <div className={`text-sm font-bold font-mono ${tone}`}>{value}</div>
    {sub && <div className="text-[10px] text-slate-500">{sub}</div>}
  </div>
);

const blankPin = { title: '', highway: '', level: 'Not sure', notes: '' };
const blankLog = { level: 'Level 1', location: '', usdot: '', carrierName: '', brakesOOS: false, tiresOOS: false, eldOOS: false, weightOverload: false, steeringOOS: false, notes: '' };

export default function App() {
  const [activeTab, setActiveTab] = useState('map');
  const [searchQuery, setSearchQuery] = useState('');
  const [show, setShow] = useState('both');
  const [levelFilter, setLevelFilter] = useState('All');
  const [isDropPinMode, setIsDropPinMode] = useState(false);
  const [pendingCoords, setPendingCoords] = useState(null);
  const [selectedItem, setSelectedItem] = useState(null);
  const [liveStatus, setLiveStatus] = useState(null);
  const [liveError, setLiveError] = useState('');

  // Spotted pins and the inspection log live in this tab only (nothing is saved).
  const [pins, setPins] = useState([]);
  const [pinForm, setPinForm] = useState(blankPin);
  const [logForm, setLogForm] = useState(blankLog);
  const [loggedInspections, setLoggedInspections] = useState([]);

  useEffect(() => {
    fetch('/api/stations', { credentials: 'same-origin', cache: 'no-store' })
      .then(async res => {
        const d = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(d.error || `status ${res.status}`);
        setLiveStatus(Object.fromEntries((d.stations || []).map(s => [s.id, {
          id: s.id, status: s.status || 'unknown', note: s.note || '', updatedAt: s.updatedAt || null,
          vehicleOosRate: s.inspections?.vehicleOosRate ?? null,
        }])));
      })
      .catch(e => setLiveError(e.message));
  }, []);

  const q = searchQuery.trim().toLowerCase();
  const filteredPorts = useMemo(() => show === 'towns' ? [] :
    PORTS.filter(p => !q || p.name.toLowerCase().includes(q) || p.highway.toLowerCase().includes(q)), [show, q]);
  const filteredTowns = useMemo(() => show === 'ports' ? [] :
    TOWNS.map(t => ({ ...t, count: t.last12(levelFilter).total }))
      .filter(t => t.count > 0 && (!q || t.name.toLowerCase().includes(q))), [show, q, levelFilter]);
  const topTowns = useMemo(() => [...filteredTowns].sort((a, b) => b.count - a.count).slice(0, 10), [filteredTowns]);

  // On phones the pin form sits below the map, so bring it into view once a spot is tapped.
  const pinFormRef = useRef(null);
  useEffect(() => { if (pendingCoords) pinFormRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, [pendingCoords]);

  const onSelect = useCallback(item => setSelectedItem(item), []);
  const handleMapClickForPin = useCallback(coords => { setPendingCoords(coords); setIsDropPinMode(false); }, []);

  const handlePinFormSubmit = (e) => {
    e.preventDefault();
    const pin = {
      id: `pin-${Date.now()}`, kind: 'pin', lat: pendingCoords.lat, lng: pendingCoords.lng,
      title: pinForm.title.trim() || `Spotted near ${pendingCoords.lat.toFixed(3)}, ${pendingCoords.lng.toFixed(3)}`,
      highway: pinForm.highway.trim(), level: pinForm.level, notes: pinForm.notes.trim(),
      time: new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Denver' }),
    };
    setPins([pin, ...pins]);
    setSelectedItem(pin);
    setPendingCoords(null);
    setPinForm(blankPin);
  };
  const deletePin = (id) => {
    setPins(pins.filter(p => p.id !== id));
    if (selectedItem?.id === id) setSelectedItem(null);
  };

  const handleLogSubmit = (e) => {
    e.preventDefault();
    const reasons = [
      logForm.brakesOOS && 'Brakes out of adjustment', logForm.tiresOOS && 'Tire / flat',
      logForm.eldOOS && 'Hours of service / ELD', logForm.weightOverload && 'Axle overweight',
      logForm.steeringOOS && 'Steering / frame'
    ].filter(Boolean);
    setLoggedInspections([{
      id: `log-${Date.now()}`,
      time: new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Denver' }),
      usdot: logForm.usdot, carrier: logForm.carrierName, level: logForm.level, location: logForm.location,
      oos: reasons.length > 0, reasons: reasons.join(', '), notes: logForm.notes
    }, ...loggedInspections]);
    setLogForm(blankLog);
  };

  const tabs = [
    { id: 'map', label: 'Map', icon: MapPin },
    { id: 'ports', label: 'Ports of Entry', icon: Building2 },
    { id: 'trends', label: 'Trends', icon: BarChart2 },
    { id: 'spotted', label: 'Spotted Today', icon: Radio, badge: pins.length },
    { id: 'logger', label: 'Inspection Log', icon: ClipboardList },
    { id: 'guide', label: 'Levels 1–5', icon: Award }
  ];
  const sessionNote = 'Kept in this browser tab only: it is gone when you reload or close the page.';
  const statusBadge = (port) => {
    const s = STATUS_STYLE[portStatus(port, liveStatus)];
    return <span className={`px-2 py-0.5 rounded text-[10px] font-bold border whitespace-nowrap ${s.cls}`}>{s.label}</span>;
  };
  const inputCls = 'w-full bg-slate-950 border border-slate-800 rounded-lg p-2 text-slate-200 outline-none focus:border-cyan-500';

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 font-sans flex flex-col">
      <header className="border-b border-slate-800 bg-slate-900/90 backdrop-blur-md sticky top-0 z-[1000] px-4 py-3 flex flex-wrap items-center justify-between gap-3 shadow-xl">
        <div className="flex items-center gap-3 min-w-0">
          <div className="bg-gradient-to-tr from-cyan-600 to-blue-600 p-2.5 rounded-xl shrink-0">
            <Truck className="w-6 h-6 text-white" />
          </div>
          <div className="min-w-0">
            <h1 className="text-lg font-bold tracking-tight text-slate-100">Colorado Truck Inspections</h1>
            <p className="text-xs text-slate-400">Ports of entry and FMCSA roadside inspections · data through {monthLabel(THROUGH, true)}</p>
          </div>
        </div>

        <nav className="order-last w-full md:order-none md:w-auto flex items-center gap-1 overflow-x-auto bg-slate-950/80 p-1 rounded-lg border border-slate-800">
          {tabs.map(tab => {
            const Icon = tab.icon;
            return (
              <button key={tab.id} onClick={() => setActiveTab(tab.id)}
                className={`shrink-0 whitespace-nowrap flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold transition-all ${
                  activeTab === tab.id ? 'bg-gradient-to-r from-cyan-600 to-blue-600 text-white shadow' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
                }`}>
                <Icon className="w-3.5 h-3.5" />
                {tab.label}
                {tab.badge > 0 && <span className="px-1.5 rounded-full bg-pink-950 text-pink-400 border border-pink-800 text-[10px] font-mono">{tab.badge}</span>}
              </button>
            );
          })}
        </nav>

        <button onClick={() => { setActiveTab('map'); setIsDropPinMode(!isDropPinMode); }}
          className={`px-3 py-1.5 rounded-lg text-xs font-bold transition flex items-center gap-1.5 shadow-lg text-white ${
            isDropPinMode ? 'bg-pink-600' : 'bg-gradient-to-r from-pink-600 to-purple-600 hover:from-pink-500 hover:to-purple-500'
          }`}>
          <Crosshair className="w-4 h-4" />
          {isDropPinMode ? 'Cancel' : 'Mark a spot'}
        </button>
      </header>

      <main className="flex-1 p-4 max-w-7xl w-full mx-auto grid grid-cols-1 lg:grid-cols-12 gap-4 content-start">

        {activeTab === 'map' && (
          <>
            {/* Shorter on phones: a one-finger drag on the map pans it, so leave page around it to scroll by. */}
            <div className="lg:col-span-8 flex flex-col gap-3 h-[440px] sm:h-[560px] lg:h-[680px] min-w-0">
              <div className="flex flex-wrap items-center gap-2 bg-slate-900/80 p-2.5 rounded-xl border border-slate-800 text-xs">
                <input type="search" placeholder="Search a town, port or highway" value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="flex-1 min-w-[10rem] bg-slate-950 border border-slate-800 rounded px-2 py-1 text-slate-200 placeholder-slate-500 outline-none focus:border-cyan-500" />
                <select value={show} onChange={(e) => setShow(e.target.value)} className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-slate-300 outline-none">
                  <option value="both">Ports and towns</option>
                  <option value="ports">Ports only</option>
                  <option value="towns">Towns only</option>
                </select>
                <select value={levelFilter} onChange={(e) => setLevelFilter(e.target.value)} className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-slate-300 outline-none" aria-label="Inspection level for town sizes">
                  <option value="All">All levels</option>
                  {Object.entries(LEVELS).map(([lv, name]) => <option key={lv} value={lv}>Level {lv} ({name})</option>)}
                </select>
              </div>
              <div className="flex-1 relative min-h-0">
                <InspectionMap ports={filteredPorts} towns={filteredTowns} pins={pins} liveStatus={liveStatus}
                  selected={selectedItem} onSelect={onSelect} isDropPinMode={isDropPinMode} onMapClickForPin={handleMapClickForPin} />
              </div>
            </div>

            <aside className="lg:col-span-4 space-y-4 min-w-0">
              {pendingCoords && (
                <form ref={pinFormRef} onSubmit={handlePinFormSubmit} className="bg-slate-900/90 border border-pink-800/60 rounded-xl p-4 space-y-3 text-xs">
                  <div className="flex justify-between items-center">
                    <h2 className="text-sm font-bold text-pink-300">Mark a spotted inspection</h2>
                    <button type="button" onClick={() => setPendingCoords(null)} aria-label="Cancel" className="text-slate-400 hover:text-slate-200"><X className="w-4 h-4" /></button>
                  </div>
                  <input className={inputCls} maxLength={80} placeholder="What you saw, e.g. portable scales at the pullout" value={pinForm.title} onChange={(e) => setPinForm({ ...pinForm, title: e.target.value })} />
                  <div className="grid grid-cols-2 gap-2">
                    <input className={inputCls} maxLength={30} placeholder="Highway, e.g. I-70 EB" value={pinForm.highway} onChange={(e) => setPinForm({ ...pinForm, highway: e.target.value })} />
                    <select className={inputCls} value={pinForm.level} onChange={(e) => setPinForm({ ...pinForm, level: e.target.value })}>
                      <option>Not sure</option>
                      {Object.keys(LEVELS).map(lv => <option key={lv}>Level {lv}</option>)}
                    </select>
                  </div>
                  <textarea className={inputCls} rows={2} maxLength={280} placeholder="Notes" value={pinForm.notes} onChange={(e) => setPinForm({ ...pinForm, notes: e.target.value })} />
                  <p className="text-[10px] text-slate-500">{sessionNote}</p>
                  <button type="submit" className="w-full py-2 bg-pink-600 hover:bg-pink-500 text-white rounded-lg font-bold">Add pin</button>
                </form>
              )}

              {selectedItem?.kind === 'port' && (() => {
                const p = selectedItem, live = liveStatus?.[p.id];
                return (
                  <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-4 shadow-xl space-y-4">
                    <div className="flex justify-between items-start gap-2 border-b border-slate-800 pb-3">
                      <div className="min-w-0">
                        <span className="text-[10px] font-mono text-red-400 font-bold uppercase tracking-wider">Port of entry</span>
                        <h2 className="text-base font-bold text-slate-100">{p.name}</h2>
                        <p className="text-xs text-slate-400">{p.highway} · {p.locations.map(l => `${l.direction} MP ${l.milepost}`).join(', ')}</p>
                      </div>
                      {statusBadge(p)}
                    </div>
                    {live?.note && <p className="text-xs text-slate-300 bg-slate-800/40 p-2 rounded border border-slate-700/50">{live.note}</p>}
                    <div className="grid grid-cols-3 gap-2">
                      <Stat label="Inspections" value={fmt(p.last12.total)} sub="last 12 mo" tone="text-cyan-400" />
                      <Stat label="Vehicle OOS" value={pct(p.last12.vehicleOosRate)} tone="text-red-400" />
                      <Stat label="Driver OOS" value={pct(p.last12.driverOosRate)} tone="text-amber-400" />
                    </div>
                    <LevelBars byLevel={p.last12.byLevel} />
                    {p.phone && <a href={`tel:${p.phone}`} className="flex items-center gap-2 text-xs text-cyan-400 hover:underline"><Phone className="w-3.5 h-3.5" />{p.phone}</a>}
                  </div>
                );
              })()}

              {selectedItem?.kind === 'town' && (() => {
                const t = selectedItem, recent = t.last12(levelFilter), all = t.allTime(levelFilter);
                const byLevel = Object.fromEntries(Object.entries(t.levels).map(([lv, c]) => [lv, c[3]]));
                return (
                  <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-4 shadow-xl space-y-4">
                    <div className="border-b border-slate-800 pb-3">
                      <span className="text-[10px] font-mono text-cyan-400 font-bold uppercase tracking-wider">Roadside inspections recorded in</span>
                      <h2 className="text-base font-bold text-slate-100">{t.name}</h2>
                      {levelFilter !== 'All' && <p className="text-xs text-slate-400">Level {levelFilter} only</p>}
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <Stat label="Last 12 months" value={fmt(recent.total)} tone="text-cyan-400" />
                      <Stat label="All years on file" value={fmt(all.total)} />
                      <Stat label="Vehicle OOS (12 mo)" value={pct(recent.vehicleOosRate)} tone="text-red-400" />
                      <Stat label="Driver OOS (12 mo)" value={pct(recent.driverOosRate)} tone="text-amber-400" />
                    </div>
                    <LevelBars byLevel={byLevel} />
                    <p className="text-[10px] text-slate-500">Matched to the town by FMCSA's location text, so it shows where inspections were recorded, not exact roadside spots.</p>
                  </div>
                );
              })()}

              {selectedItem?.kind === 'pin' && (
                <div className="bg-slate-900/90 border border-pink-800/60 rounded-xl p-4 shadow-xl space-y-3 text-xs">
                  <span className="text-[10px] font-mono text-pink-400 font-bold uppercase">Spotted {selectedItem.time}</span>
                  <h2 className="text-base font-bold text-slate-100">{selectedItem.title}</h2>
                  <p className="text-slate-400">{[selectedItem.highway, selectedItem.level].filter(Boolean).join(' · ')}</p>
                  {selectedItem.notes && <p className="text-slate-300">{selectedItem.notes}</p>}
                  <button onClick={() => deletePin(selectedItem.id)} className="flex items-center gap-1.5 px-3 py-1.5 bg-red-950 hover:bg-red-900 text-red-300 rounded-lg border border-red-800"><Trash2 className="w-3.5 h-3.5" />Remove pin</button>
                </div>
              )}

              <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-4 space-y-2">
                <h3 className="text-sm font-semibold text-slate-200">Busiest towns, last 12 months</h3>
                {topTowns.length ? (
                  <ol className="divide-y divide-slate-800">
                    {topTowns.map((t, i) => (
                      <li key={t.id}>
                        <button onClick={() => onSelect(TOWNS.find(x => x.id === t.id))} className="w-full flex justify-between gap-2 py-1.5 text-xs text-left hover:text-cyan-300">
                          <span className="text-slate-300"><span className="text-slate-500 font-mono mr-2">{i + 1}</span>{t.name}</span>
                          <span className="font-mono text-slate-400">{fmt(t.count)}</span>
                        </button>
                      </li>
                    ))}
                  </ol>
                ) : <p className="text-xs text-slate-500">No towns match.</p>}
                <p className="text-[10px] text-slate-500">Tap a town or port on the map for details.</p>
              </div>
            </aside>
          </>
        )}

        {activeTab === 'ports' && (
          <div className="lg:col-span-12 space-y-3">
            {liveError && (
              <p className="text-xs text-amber-300 bg-amber-950/40 border border-amber-800/60 rounded-lg p-2.5">
                Live open/closed status isn't available right now ({liveError}).
              </p>
            )}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {PORTS.map(p => (
                <div key={p.id} className="bg-slate-900/90 border border-slate-800 rounded-xl p-4 space-y-3">
                  <div className="flex justify-between items-start gap-2">
                    <div className="min-w-0">
                      <h3 className="text-sm font-bold text-slate-100">{p.name}</h3>
                      <p className="text-xs text-slate-400">{p.highway} · MP {[...new Set(p.locations.map(l => l.milepost))].join(' / ')}</p>
                    </div>
                    {statusBadge(p)}
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <Stat label="Inspections" value={fmt(p.last12.total)} sub="12 mo" tone="text-cyan-400" />
                    <Stat label="Vehicle OOS" value={pct(p.last12.vehicleOosRate)} tone="text-red-400" />
                    <Stat label="Driver OOS" value={pct(p.last12.driverOosRate)} tone="text-amber-400" />
                  </div>
                  <div className="flex justify-between items-center text-xs">
                    {p.phone ? <a href={`tel:${p.phone}`} className="text-cyan-400 hover:underline">{p.phone}</a> : <span />}
                    <button onClick={() => { setSelectedItem(p); setActiveTab('map'); }} className="px-2 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded">Show on map</button>
                  </div>
                </div>
              ))}
            </div>
            <p className="text-[10px] text-slate-500">Last 12 months = {PERIOD}. Vehicle OOS counts Levels 1, 2 and 5; driver OOS counts Levels 1, 2 and 3.</p>
          </div>
        )}

        {activeTab === 'trends' && (
          <div className="lg:col-span-12 space-y-4">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Stat label="Port inspections, last 12 mo" value={fmt(PORTS_LAST_12.total)} tone="text-cyan-400" />
              <Stat label="Port vehicle OOS rate" value={pct(PORTS_LAST_12.vehicleOosRate)} tone="text-red-400" />
              <Stat label="Port driver OOS rate" value={pct(PORTS_LAST_12.driverOosRate)} tone="text-amber-400" />
              <Stat label="All CO inspections, 12 mo" value={fmt(STATE_LAST_12)} sub="ports + towns" />
            </div>
            <MonthlyChart months={PORT_TREND.months} title="Inspections at the 10 ports of entry, by month" />
            <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-4">
              <h3 className="text-sm font-semibold text-slate-200 mb-3">Ports by inspection level, last 12 months</h3>
              <LevelBars byLevel={PORTS_LAST_12.byLevel} />
            </div>
            <p className="text-[10px] text-slate-500">
              Source: FMCSA Vehicle Inspection File via the cdot-stations app, fetched {new Date(FETCHED_AT).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}.
              {' '}{fmt(COVERAGE.unmapped)} inspections ({fmt(COVERAGE.unmappedLocations)} location names) couldn't be matched to a town and aren't on the map.
            </p>
          </div>
        )}

        {activeTab === 'spotted' && (
          <div className="lg:col-span-12 bg-slate-900/90 border border-slate-800 rounded-xl p-5 space-y-4">
            <div className="flex flex-wrap justify-between items-center gap-2 border-b border-slate-800 pb-3">
              <div>
                <h2 className="text-base font-bold text-slate-100">Spotted today</h2>
                <p className="text-xs text-slate-400">{sessionNote}</p>
              </div>
              <button onClick={() => { setActiveTab('map'); setIsDropPinMode(true); }}
                className="px-3 py-2 bg-gradient-to-r from-pink-600 to-purple-600 text-white rounded-lg text-xs font-bold flex items-center gap-1.5"><Plus className="w-4 h-4" />Mark a spot</button>
            </div>
            {pins.length ? (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                {pins.map(pin => (
                  <div key={pin.id} className="bg-slate-950 border border-slate-800 rounded-xl p-4 space-y-2 text-xs">
                    <span className="font-mono text-pink-400">{pin.time}</span>
                    <h3 className="text-sm font-bold text-slate-100">{pin.title}</h3>
                    <p className="text-slate-400">{[pin.highway, pin.level].filter(Boolean).join(' · ')}</p>
                    {pin.notes && <p className="text-slate-300">{pin.notes}</p>}
                    <div className="flex gap-2 pt-1">
                      <button onClick={() => { setSelectedItem(pin); setActiveTab('map'); }} className="px-2 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded">Show on map</button>
                      <button onClick={() => deletePin(pin.id)} className="p-1 text-red-400 hover:bg-red-950/50 rounded" aria-label="Remove pin"><Trash2 className="w-3.5 h-3.5" /></button>
                    </div>
                  </div>
                ))}
              </div>
            ) : <p className="text-sm text-slate-500 py-6 text-center">Nothing marked yet. Use "Mark a spot", then tap the map.</p>}
          </div>
        )}

        {activeTab === 'logger' && (
          <div className="lg:col-span-12 grid grid-cols-1 lg:grid-cols-12 gap-4">
            <div className="lg:col-span-7 bg-slate-900/90 border border-slate-800 rounded-xl p-5 space-y-4 min-w-0">
              <div className="border-b border-slate-800 pb-3">
                <h2 className="text-base font-bold text-slate-100">Log one of our trucks' inspections</h2>
                <p className="text-xs text-slate-400">{sessionNote}</p>
              </div>
              <form onSubmit={handleLogSubmit} className="space-y-3 text-xs">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <label className="block text-slate-400 font-semibold">Level
                    <select value={logForm.level} onChange={(e) => setLogForm({ ...logForm, level: e.target.value })} className={`${inputCls} mt-1`}>
                      {Object.entries(LEVELS).map(([lv, name]) => <option key={lv} value={`Level ${lv}`}>Level {lv} – {name}</option>)}
                    </select>
                  </label>
                  <label className="block text-slate-400 font-semibold">Where
                    <input value={logForm.location} onChange={(e) => setLogForm({ ...logForm, location: e.target.value })} placeholder="e.g. Dumont port, I-70 WB" className={`${inputCls} mt-1`} />
                  </label>
                  <label className="block text-slate-400 font-semibold">USDOT number
                    <input value={logForm.usdot} onChange={(e) => setLogForm({ ...logForm, usdot: e.target.value })} className={`${inputCls} mt-1 font-mono`} />
                  </label>
                  <label className="block text-slate-400 font-semibold">Truck / carrier
                    <input value={logForm.carrierName} onChange={(e) => setLogForm({ ...logForm, carrierName: e.target.value })} className={`${inputCls} mt-1`} />
                  </label>
                </div>
                <fieldset className="bg-slate-950 p-3 rounded-xl border border-slate-800">
                  <legend className="px-1 font-bold text-amber-400 flex items-center gap-1.5"><AlertTriangle className="w-4 h-4" />Put out of service for</legend>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-slate-300">
                    {[['brakesOOS', 'Brakes out of adjustment'], ['tiresOOS', 'Tire / flat'], ['eldOOS', 'Hours of service / ELD'], ['weightOverload', 'Axle overweight'], ['steeringOOS', 'Steering / frame']].map(([key, label]) => (
                      <label key={key} className="flex items-center gap-2 cursor-pointer">
                        <input type="checkbox" checked={logForm[key]} onChange={(e) => setLogForm({ ...logForm, [key]: e.target.checked })} />
                        {label}
                      </label>
                    ))}
                  </div>
                </fieldset>
                <textarea rows={2} value={logForm.notes} onChange={(e) => setLogForm({ ...logForm, notes: e.target.value })} placeholder="Notes" className={inputCls} />
                <button type="submit" className="w-full py-2.5 bg-gradient-to-r from-emerald-600 to-cyan-600 hover:from-emerald-500 hover:to-cyan-500 text-white rounded-lg font-bold">Add to log</button>
              </form>
            </div>
            <div className="lg:col-span-5 bg-slate-900/90 border border-slate-800 rounded-xl p-4 space-y-2.5 min-w-0">
              <h3 className="text-sm font-bold text-slate-100 flex justify-between"><span>This session's log</span><span className="text-[10px] font-mono text-cyan-400">{loggedInspections.length}</span></h3>
              {loggedInspections.length ? loggedInspections.map(insp => (
                <div key={insp.id} className="bg-slate-950 p-3 rounded-lg border border-slate-800 space-y-1 text-xs">
                  <div className="flex justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-bold text-slate-200">{insp.carrier || 'Truck'} · {insp.level}</div>
                      <div className="text-[10px] text-slate-400">{[insp.time, insp.usdot, insp.location].filter(Boolean).join(' · ')}</div>
                    </div>
                    <span className={`px-2 py-0.5 h-fit rounded text-[10px] font-bold border ${insp.oos ? 'bg-red-950 text-red-400 border-red-800' : 'bg-emerald-950 text-emerald-400 border-emerald-800'}`}>{insp.oos ? 'Out of service' : 'Passed'}</span>
                  </div>
                  {insp.oos && <div className="text-[10px] text-red-400">{insp.reasons}</div>}
                  {insp.notes && <div className="text-[10px] text-slate-400">{insp.notes}</div>}
                </div>
              )) : <p className="text-xs text-slate-500 py-4 text-center">Nothing logged yet.</p>}
            </div>
          </div>
        )}

        {activeTab === 'guide' && (
          <div className="lg:col-span-12 bg-slate-900/90 border border-slate-800 rounded-xl p-5 space-y-4">
            <div className="border-b border-slate-800 pb-3">
              <h2 className="text-base font-bold text-slate-100 flex items-center gap-2"><Award className="w-5 h-5 text-cyan-400" />CVSA inspection levels, quick reference</h2>
              <p className="text-xs text-slate-400">General guide. Check CVSA's current out-of-service criteria before relying on it.</p>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {[
                { level: 'Level 1', title: 'North American Standard Inspection', time: '45-60 mins',
                  scope: 'Most comprehensive inspection. Includes full under-vehicle chassis inspection, steering, brakes, suspension, driver credentials, and ELD logbook.',
                  checks: ['Brake System Adjustment', 'Coupling Devices', 'Fuel System & Exhaust', 'Steering Mechanism', 'Driver ELD & Medical Cert'],
                  oosRule: '20% or more of service brakes inoperative = Out of Service.' },
                { level: 'Level 2', title: 'Walk-Around Driver & Vehicle Inspection', time: '25-30 mins',
                  scope: 'Includes all items checked in Level 1 without physically crawling underneath the vehicle chassis.',
                  checks: ['Outer Wheel & Tire Condition', 'Lighting & Placards', 'Driver License & Medical', 'Load Securement'],
                  oosRule: 'Flat tire or exposed ply cord = Immediate OOS.' },
                { level: 'Level 3', title: 'Driver Credentials & Administrative Inspection', time: '15-20 mins',
                  scope: 'Focused purely on driver compliance, Electronic Logging Device (ELD) hours-of-service, license class, and hazmat endorsements.',
                  checks: ['Commercial Driver License (CDL)', 'Medical Examiner Cert', 'RODS / Hours of Service', 'Seat Belt Compliance'],
                  oosRule: 'HOS false log or exceeded driving window = 10hr-34hr OOS.' },
                { level: 'Level 4', title: 'Special Targeted Component Inspection', time: '10-15 mins',
                  scope: 'One-time study or targeted enforcement on a specific component (e.g., brake adjustment campaign or chain law enforcement).',
                  checks: ['Targeted Axle Brakes', 'Snow Chain Tread Depth', 'Agricultural Placards'],
                  oosRule: 'Non-compliance with targeted bulletin.' },
                { level: 'Level 5', title: 'Vehicle-Only Inspection (No Driver Present)', time: '30-40 mins',
                  scope: 'Full mechanical check of vehicle components at a terminal or carrier facility without the driver present.',
                  checks: ['Chassis & Frame Integrity', 'Brake System Mechanics', 'Tires & Wheels', 'Exhaust System'],
                  oosRule: 'Chassis crack or major brake failure.' }
              ].map(item => (
                <div key={item.level} className="bg-slate-950 border border-slate-800 rounded-xl p-4 space-y-3 flex flex-col justify-between">
                  <div>
                    <div className="flex justify-between items-center mb-1">
                      <span className="font-mono text-cyan-400 font-bold text-sm">{item.level}</span>
                      <span className="text-[10px] font-mono text-slate-500 bg-slate-900 px-2 py-0.5 rounded">{item.time}</span>
                    </div>
                    <h3 className="text-xs font-bold text-slate-200 mb-2">{item.title}</h3>
                    <p className="text-xs text-slate-400 leading-relaxed mb-3">{item.scope}</p>
                    <ul className="text-xs text-slate-400 space-y-0.5 list-disc list-inside">{item.checks.map(c => <li key={c}>{c}</li>)}</ul>
                  </div>
                  <div className="bg-red-950/30 border border-red-900/40 p-2 rounded text-[11px] text-red-300"><span className="font-bold">OOS rule:</span> {item.oosRule}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
