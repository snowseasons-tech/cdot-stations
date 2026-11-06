import React, { useState, useEffect, useMemo, useRef } from 'react';
import { 
  MapPin, ShieldAlert, Truck, AlertTriangle, Scale, CheckCircle2, XCircle, 
  Search, Filter, RefreshCw, FileText, BarChart2, Layers, Cpu, Server, 
  Wrench, ChevronRight, Sun, Moon, Copy, Check, Eye, HelpCircle, Navigation, 
  PlusCircle, Award, ClipboardList, Zap, ArrowUpRight, Activity, Clock, Trash2,
  Crosshair, Plus, ShieldCheck, FileCheck, Radio, AlertOctagon, CornerDownRight, X,
  Terminal, Play, Code, Send, Database, Globe
} from 'lucide-react';

// Leaflet Interactive Map Component with Drop-Pin Listener
const LeafletMobileMap = ({ 
  officialUnits, 
  userPins, 
  selectedPin, 
  onSelectPin, 
  isDropPinMode, 
  onMapClickForPin 
}) => {
  const mapRef = useRef(null);
  const leafletInstance = useRef(null);
  const markersRef = useRef({});

  useEffect(() => {
    // Dynamically inject Leaflet CSS if not already present
    if (!document.getElementById('leaflet-css')) {
      const link = document.createElement('link');
      link.id = 'leaflet-css';
      link.rel = 'stylesheet';
      link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
      document.head.appendChild(link);
    }

    const initMap = () => {
      if (window.L && mapRef.current && !leafletInstance.current) {
        // Centered on Colorado
        const map = window.L.map(mapRef.current, {
          zoomControl: false
        }).setView([39.2501, -105.5821], 7.5);
        
        window.L.control.zoom({ position: 'bottomright' }).addTo(map);

        window.L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
          attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
          subdomains: 'abcd',
          maxZoom: 19
        }).addTo(map);

        leafletInstance.current = map;
      }
    };

    if (window.L) {
      initMap();
    } else {
      const script = document.createElement('script');
      script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
      script.onload = initMap;
      document.head.appendChild(script);
    }

    return () => {
      if (leafletInstance.current) {
        leafletInstance.current.remove();
        leafletInstance.current = null;
      }
    };
  }, []);

  // Map Click Listener for Pin Dropping
  useEffect(() => {
    if (!leafletInstance.current) return;
    const map = leafletInstance.current;

    const handleMapClick = (e) => {
      if (isDropPinMode) {
        onMapClickForPin({ lat: e.latlng.lat, lng: e.latlng.lng });
      }
    };

    map.on('click', handleMapClick);
    return () => {
      map.off('click', handleMapClick);
    };
  }, [isDropPinMode, onMapClickForPin]);

  // Update Markers for Official Units and User Pins
  useEffect(() => {
    if (!leafletInstance.current || !window.L) return;

    const map = leafletInstance.current;
    
    // Clear existing markers
    Object.values(markersRef.current).forEach(marker => marker.remove());
    markersRef.current = {};

    // 1. Render Official CSP Units
    officialUnits.forEach(unit => {
      const isSelected = selectedPin?.id === unit.id;
      
      const statusColor = unit.type === 'Active Mobile Detail' ? '#10B981' :
                         unit.type === 'Portable Scale Checkpoint' ? '#06B6D4' :
                         unit.type === 'Chain Station Sweep' ? '#F59E0B' : '#8B5CF6';

      const iconEmoji = unit.type === 'Active Mobile Detail' ? '🚓' :
                        unit.type === 'Portable Scale Checkpoint' ? '⚖️' :
                        unit.type === 'Chain Station Sweep' ? '⛓️' : '🏛️';

      const customIcon = window.L.divIcon({
        className: 'custom-leaflet-marker',
        html: `
          <div style="
            background: #0f172a;
            border: 2px solid ${statusColor};
            border-radius: 50%;
            width: ${isSelected ? '36px' : '30px'};
            height: ${isSelected ? '36px' : '30px'};
            display: flex;
            align-items: center;
            justify-content: center;
            box-shadow: 0 0 14px ${statusColor}a0;
            cursor: pointer;
            transition: all 0.2s ease;
          ">
            <span style="font-size: ${isSelected ? '16px' : '13px'};">
              ${iconEmoji}
            </span>
          </div>
        `,
        iconSize: [isSelected ? 36 : 30, isSelected ? 36 : 30],
        iconAnchor: [isSelected ? 18 : 15, isSelected ? 18 : 15]
      });

      const marker = window.L.marker([unit.lat, unit.lng], { icon: customIcon }).addTo(map);

      const popupHtml = `
        <div style="font-family: system-ui, sans-serif; color: #0f172a; min-width: 210px;">
          <div style="font-weight: 700; font-size: 13px; color: #0f172a; margin-bottom: 2px;">${unit.name}</div>
          <div style="font-size: 11px; color: #64748b; margin-bottom: 6px;">${unit.corridor} • Unit: ${unit.unitId}</div>
          <div style="background: #f8fafc; padding: 6px 8px; border-radius: 6px; font-size: 11px; margin-bottom: 6px; border: 1px solid #e2e8f0;">
            <div>Target Levels: <b>${unit.supportedLevels.join(', ')}</b></div>
            <div>Troopers On-Duty: <b>${unit.troopers}</b></div>
            <div>Inspections Today: <b>${unit.inspectionsToday}</b></div>
            <div>OOS Violations: <b style="color: #ef4444;">${unit.oosCount}</b></div>
          </div>
          <div style="font-size: 10px; color: ${statusColor}; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px;">
            ● OFFICIAL ${unit.type} (${unit.status})
          </div>
        </div>
      `;

      marker.bindPopup(popupHtml);
      marker.on('click', () => onSelectPin(unit));
      markersRef.current[unit.id] = marker;
    });

    // 2. Render Crowdsourced User Pins
    userPins.forEach(pin => {
      const isSelected = selectedPin?.id === pin.id;
      const isResolved = pin.status === 'Resolved / Cleared';
      const statusColor = isResolved ? '#64748B' : '#EC4899'; // Hot Pink for active user observations

      const customIcon = window.L.divIcon({
        className: 'custom-user-marker',
        html: `
          <div style="
            background: #18181b;
            border: 2.5px solid ${statusColor};
            border-radius: 50% 50% 50% 0;
            transform: rotate(-45deg);
            width: ${isSelected ? '36px' : '30px'};
            height: ${isSelected ? '36px' : '30px'};
            display: flex;
            align-items: center;
            justify-content: center;
            box-shadow: 0 0 16px ${statusColor}b0;
            cursor: pointer;
            transition: all 0.2s ease;
          ">
            <span style="transform: rotate(45deg); font-size: ${isSelected ? '14px' : '11px'}; font-weight: bold; color: #f472b6;">
              📍
            </span>
          </div>
        `,
        iconSize: [isSelected ? 36 : 30, isSelected ? 36 : 30],
        iconAnchor: [isSelected ? 18 : 15, isSelected ? 36 : 30]
      });

      const marker = window.L.marker([pin.lat, pin.lng], { icon: customIcon }).addTo(map);

      const popupHtml = `
        <div style="font-family: system-ui, sans-serif; color: #0f172a; min-width: 220px;">
          <div style="display: flex; align-items: center; gap: 4px; font-size: 10px; font-weight: 800; color: #ec4899; text-transform: uppercase; margin-bottom: 2px;">
            <span>📍 CROWDSOURCED OBSERVATION</span>
          </div>
          <div style="font-weight: 700; font-size: 13px; color: #0f172a;">${pin.title}</div>
          <div style="font-size: 11px; color: #64748b; margin-bottom: 6px;">${pin.corridor} • Reported: ${pin.timestamp}</div>
          <div style="background: #fdf2f8; border: 1px solid #fbcfe8; padding: 6px 8px; border-radius: 6px; font-size: 11px; margin-bottom: 6px;">
            <div>Observed Level: <b>${pin.level}</b></div>
            <div>Equipment: <b>${pin.scaleType}</b></div>
            <div>Reporter: <b>${pin.reportedBy}</b></div>
          </div>
          <div style="font-size: 11px; color: #334155; font-style: italic;">"${pin.notes}"</div>
        </div>
      `;

      marker.bindPopup(popupHtml);
      marker.on('click', () => onSelectPin(pin));
      markersRef.current[pin.id] = marker;
    });

    if (selectedPin) {
      map.flyTo([selectedPin.lat, selectedPin.lng], 10, { duration: 1.2 });
      if (markersRef.current[selectedPin.id]) {
        markersRef.current[selectedPin.id].openPopup();
      }
    }
  }, [officialUnits, userPins, selectedPin, onSelectPin]);

  return (
    <div className="relative w-full h-full rounded-xl overflow-hidden border border-slate-700/60 shadow-2xl">
      <div ref={mapRef} className={`w-full h-full bg-slate-950 z-0 ${isDropPinMode ? 'cursor-crosshair' : ''}`} />
      
      {/* Drop Pin Mode Overlay Banner */}
      {isDropPinMode && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-20 bg-pink-950/90 text-pink-200 border border-pink-500/60 backdrop-blur-md px-4 py-2 rounded-full shadow-2xl flex items-center gap-2 animate-bounce text-xs font-bold">
          <Crosshair className="w-4 h-4 text-pink-400 animate-spin" />
          <span>Click anywhere on the map to set custom observation coordinates!</span>
        </div>
      )}

      {/* Floating Map Legend */}
      <div className="absolute top-4 right-4 z-10 bg-slate-900/90 backdrop-blur-md p-3 rounded-xl border border-slate-700/60 shadow-2xl text-xs space-y-2 text-slate-300 max-w-[210px]">
        <div className="font-semibold text-slate-100 flex items-center gap-1.5 border-b border-slate-700 pb-1.5 text-[11px]">
          <ShieldAlert className="w-3.5 h-3.5 text-cyan-400" />
          Map Legend & Pin Types
        </div>
        <div className="flex items-center gap-2 text-[11px]">
          <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 shadow-[0_0_8px_#10B981]"></span>
          <span>Official Roving Patrol</span>
        </div>
        <div className="flex items-center gap-2 text-[11px]">
          <span className="w-2.5 h-2.5 rounded-full bg-cyan-500 shadow-[0_0_8px_#06B6D4]"></span>
          <span>Portable Scale Station</span>
        </div>
        <div className="flex items-center gap-2 text-[11px]">
          <span className="w-2.5 h-2.5 rounded-full bg-amber-500 shadow-[0_0_8px_#F59E0B]"></span>
          <span>Chain Station Safety Sweep</span>
        </div>
        <div className="flex items-center gap-2 text-[11px]">
          <span className="w-2.5 h-2.5 rounded-full bg-pink-500 shadow-[0_0_8px_#EC4899]"></span>
          <span className="font-semibold text-pink-300">Crowdsourced User Pin</span>
        </div>
      </div>
    </div>
  );
};

// SVG Simple Analytics Line Chart Component
const SimpleTrendChart = ({ data, color, title, unit }) => {
  const points = data.map((val, i) => {
    const x = (i / (data.length - 1)) * 300;
    const min = Math.min(...data);
    const max = Math.max(...data);
    const range = (max - min) || 1;
    const y = 80 - ((val - min) / range) * 60;
    return `${x},${y}`;
  }).join(' ');

  const currentVal = data[data.length - 1];

  return (
    <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-4 shadow-xl">
      <div className="flex justify-between items-center mb-2">
        <span className="text-xs text-slate-400 font-semibold">{title}</span>
        <span className="text-sm font-mono font-bold" style={{ color }}>
          {currentVal} {unit}
        </span>
      </div>
      <div className="h-24 w-full relative">
        <svg viewBox="0 0 300 90" className="w-full h-full overflow-visible">
          <polyline
            fill="none"
            stroke={color}
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            points={points}
          />
          <polygon
            fill={`${color}20`}
            points={`0,85 ${points} 300,85`}
          />
        </svg>
      </div>
      <div className="flex justify-between text-[10px] text-slate-500 mt-1 font-mono">
        <span>06:00 AM</span>
        <span>12:00 PM</span>
        <span>Current</span>
      </div>
    </div>
  );
};

export default function App() {
  const [theme, setTheme] = useState('dark');
  const [activeTab, setActiveTab] = useState('map'); // 'map', 'userPins', 'logger', 'guide', 'analytics', 'api'
  
  // Search & Filter state
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCorridor, setSelectedCorridor] = useState('All');
  const [selectedLevelFilter, setSelectedLevelFilter] = useState('All');

  // Map Drop-Pin State
  const [isDropPinMode, setIsDropPinMode] = useState(false);
  const [pendingCoords, setPendingCoords] = useState(null);
  const [isModalOpen, setIsModalOpen] = useState(false);

  // Selected Pin / Unit State
  const [selectedItem, setSelectedItem] = useState(null);

  // Official CSP & CDOT Mobile Operations Data
  const [officialUnits] = useState([
    {
      id: 'CSP-ROV-101',
      isOfficial: true,
      unitId: 'Troop 3A-Mobile 4',
      name: 'I-70 Mountain Corridor - Georgetown Pullout',
      corridor: 'I-70 Mountain Corridor',
      type: 'Active Mobile Detail',
      status: 'Active',
      lat: 39.7058,
      lng: -105.6975,
      supportedLevels: ['Level 1', 'Level 2', 'Level 3'],
      troopers: 3,
      inspectionsToday: 14,
      oosCount: 4,
      lastCheck: '10 mins ago',
      details: 'Focus on runaway truck ramp compliance, mountain brake checks, and ELD logbook audits.',
      portableScaleActive: true
    },
    {
      id: 'CSP-SCALE-202',
      isOfficial: true,
      unitId: 'Port of Entry Mobile-12',
      name: 'US-85 Commerce City Portable Weigh Station',
      corridor: 'US-85 Corridor',
      type: 'Portable Scale Checkpoint',
      status: 'Active',
      lat: 39.8402,
      lng: -104.9351,
      supportedLevels: ['Level 2', 'Level 3', 'Level 4'],
      troopers: 4,
      inspectionsToday: 28,
      oosCount: 6,
      lastCheck: '2 mins ago',
      details: 'Portable wheel-load scale operations monitoring gravel haulers and heavy freight.',
      portableScaleActive: true
    },
    {
      id: 'CSP-CHAIN-303',
      isOfficial: true,
      unitId: 'Troop 1C Roving',
      name: 'Vail Pass Chain-Up Safety Sweep',
      corridor: 'I-70 Mountain Corridor',
      type: 'Chain Station Sweep',
      status: 'Active',
      lat: 39.5308,
      lng: -106.2173,
      supportedLevels: ['Level 2', 'Level 3'],
      troopers: 2,
      inspectionsToday: 19,
      oosCount: 3,
      lastCheck: '15 mins ago',
      details: 'Chain law enforcement detail verifying tire tread depth, automatic chains, and brake adjustments.',
      portableScaleActive: false
    },
    {
      id: 'CSP-BASE-404',
      isOfficial: true,
      unitId: 'CSP Troop 3A HQ',
      name: 'Greeley Motor Carrier Base & Staging',
      corridor: 'I-76 / US-85',
      type: 'CSP Motor Carrier Base',
      status: 'Staged',
      lat: 40.4233,
      lng: -104.7086,
      supportedLevels: ['Level 1', 'Level 5'],
      troopers: 6,
      inspectionsToday: 8,
      oosCount: 1,
      lastCheck: '1 hour ago',
      details: 'Command base for mobile dispatch, post-crash vehicle teardowns, and Level 5 terminal checks.',
      portableScaleActive: false
    },
    {
      id: 'CSP-ROV-505',
      isOfficial: true,
      unitId: 'Troop 2B Roving',
      name: 'Monument Hill Rest Area Roving Detail',
      corridor: 'I-25 Corridor',
      type: 'Active Mobile Detail',
      status: 'Active',
      lat: 39.1235,
      lng: -104.8683,
      supportedLevels: ['Level 1', 'Level 2', 'Level 3', 'Level 4'],
      troopers: 3,
      inspectionsToday: 22,
      oosCount: 5,
      lastCheck: '5 mins ago',
      details: 'Roving inspection sweep monitoring interstate freight between Denver and Colorado Springs.',
      portableScaleActive: true
    }
  ]);

  // Crowdsourced User-Dropped Pins State
  const [userPins, setUserPins] = useState([
    {
      id: 'USER-PIN-801',
      isOfficial: false,
      title: 'I-70 EB MP 238 Idaho Springs Portable Scales',
      corridor: 'I-70 Mountain Corridor',
      type: 'Portable Scale Checkpoint',
      level: 'Level 2 Walk-around',
      scaleType: 'Portable Wheel Load Weigh Pads',
      lat: 39.7425,
      lng: -105.5138,
      status: 'Active Observation',
      reportedBy: 'Driver_Trucker_CO',
      timestamp: '20 mins ago',
      notes: '2 CSP vehicles and portable scales setup on eastbound pullout area checking gravel semi-trucks.',
      activeUnits: '2 Patrol Cars, 1 POE Van'
    },
    {
      id: 'USER-PIN-802',
      isOfficial: false,
      title: 'US-50 MP 385 Lamar Border Spot Safety Check',
      corridor: 'US-50 Corridor',
      type: 'Roving Patrol Spot',
      level: 'Level 3 Driver/Credentials',
      scaleType: 'Visual / Driver Log Check',
      lat: 38.0825,
      lng: -102.6152,
      status: 'Active Observation',
      reportedBy: 'FreightWatcher303',
      timestamp: '45 mins ago',
      notes: 'Roving CSP unit pulling over eastbound livestock trailers for logbook and weight verification.',
      activeUnits: '1 CSP Trooper Unit'
    }
  ]);

  // Modal Form State for Dropping Pins
  const [newPinForm, setNewPinForm] = useState({
    title: '',
    corridor: 'I-70 Mountain Corridor',
    type: 'Portable Scale Checkpoint',
    level: 'Level 1 Full Vehicle & Driver',
    scaleType: 'Portable Wheel Load Weigh Pads',
    activeUnits: '1 Patrol Unit, Portable Scale Set',
    reportedBy: 'Anonymous Inspector / Driver',
    notes: ''
  });

  // Digital Inspection Logger Form State & History
  const [logForm, setLogForm] = useState({
    usdot: 'USDOT-3981023',
    carrierName: 'Rocky Mountain Logistics LLC',
    driverName: 'John Doe',
    driverLicense: 'CO-DL981240A',
    level: 'Level 1',
    vehicleType: 'Tractor Semi-Trailer (Class 8)',
    location: 'I-70 MP 226 Georgetown Pullout',
    brakesOOS: false,
    tiresOOS: false,
    eldOOS: false,
    hazmatOOS: false,
    weightOverload: false,
    steeringOOS: false,
    notes: 'Steering axle brake adjustment within limits. ELD logs verified valid for 70hr/8day.'
  });

  const [loggedInspections, setLoggedInspections] = useState([
    {
      id: 'INSP-2026-901',
      time: '09:12 AM',
      usdot: 'USDOT-1829012',
      carrier: 'Mile High Freight Inc',
      level: 'Level 1',
      location: 'I-70 Georgetown Pullout',
      status: 'Passed',
      oosReason: 'None',
      decalIssued: true
    },
    {
      id: 'INSP-2026-902',
      time: '08:45 AM',
      usdot: 'USDOT-4091823',
      carrier: 'Front Range Express',
      level: 'Level 1',
      location: 'I-25 Monument Hill',
      status: 'Out of Service (OOS)',
      oosReason: 'Brake Pushrod Travel Exceeded 20%',
      decalIssued: false
    },
    {
      id: 'INSP-2026-903',
      time: '08:20 AM',
      usdot: 'USDOT-2910382',
      carrier: 'San Juan Haulers',
      level: 'Level 3',
      location: 'US-50 Lamar Checkpoint',
      status: 'Passed',
      oosReason: 'None',
      decalIssued: false
    }
  ]);

  // API Playground State
  const [apiEndpoint, setApiEndpoint] = useState('/api/v1/observations');
  const [apiMethod, setApiMethod] = useState('GET');
  const [apiLang, setApiLang] = useState('curl');
  const [apiParamCorridor, setApiParamCorridor] = useState('All');
  const [apiPayload, setApiPayload] = useState(JSON.stringify({
    title: "I-70 EB MP 238 Idaho Springs Portable Scales",
    corridor: "I-70 Mountain Corridor",
    type: "Portable Scale Checkpoint",
    level: "Level 1 Full Inspection",
    lat: 39.7425,
    lng: -105.5138,
    notes: "Mobile scale setup observing freight vehicles"
  }, null, 2));
  const [apiResponse, setApiResponse] = useState(null);
  const [isLoadingApi, setIsLoadingApi] = useState(false);
  const [copiedCode, setCopiedCode] = useState(false);

  // Handle map click when in Drop Pin mode
  const handleMapClickForPin = (coords) => {
    setPendingCoords(coords);
    setIsDropPinMode(false);
    setIsModalOpen(true);
  };

  // Submit User Pin Form
  const handlePinFormSubmit = (e) => {
    e.preventDefault();
    if (!pendingCoords) return;

    const newPin = {
      id: `USER-PIN-${Math.floor(100 + Math.random() * 900)}`,
      isOfficial: false,
      title: newPinForm.title || `Observation near ${pendingCoords.lat.toFixed(3)}, ${pendingCoords.lng.toFixed(3)}`,
      corridor: newPinForm.corridor,
      type: newPinForm.type,
      level: newPinForm.level,
      scaleType: newPinForm.scaleType,
      lat: pendingCoords.lat,
      lng: pendingCoords.lng,
      status: 'Active Observation',
      reportedBy: newPinForm.reportedBy || 'User Observation',
      timestamp: 'Just now',
      notes: newPinForm.notes || 'User observed commercial inspection activity at this location.',
      activeUnits: newPinForm.activeUnits
    };

    setUserPins([newPin, ...userPins]);
    setSelectedItem(newPin);
    setIsModalOpen(false);
    setPendingCoords(null);
    setNewPinForm({
      title: '',
      corridor: 'I-70 Mountain Corridor',
      type: 'Portable Scale Checkpoint',
      level: 'Level 1 Full Vehicle & Driver',
      scaleType: 'Portable Wheel Load Weigh Pads',
      activeUnits: '1 Patrol Unit, Portable Scale Set',
      reportedBy: 'Anonymous Inspector / Driver',
      notes: ''
    });
  };

  const handleLogSubmit = (e) => {
    e.preventDefault();
    const isOOS = logForm.brakesOOS || logForm.tiresOOS || logForm.eldOOS || logForm.hazmatOOS || logForm.weightOverload || logForm.steeringOOS;
    const oosReasons = [];
    if (logForm.brakesOOS) oosReasons.push('Brakes Exceeded Limit');
    if (logForm.tiresOOS) oosReasons.push('Tire Tread Exposure');
    if (logForm.eldOOS) oosReasons.push('ELD Hours-of-Service Violation');
    if (logForm.hazmatOOS) oosReasons.push('Hazmat Placard Error');
    if (logForm.weightOverload) oosReasons.push('Portable Scale Axle Overload');
    if (logForm.steeringOOS) oosReasons.push('Steering Mechanism Play');

    const newInsp = {
      id: `INSP-2026-${Math.floor(100 + Math.random() * 900)}`,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      usdot: logForm.usdot,
      carrier: logForm.carrierName,
      level: logForm.level,
      location: logForm.location,
      status: isOOS ? 'Out of Service (OOS)' : 'Passed',
      oosReason: isOOS ? oosReasons.join(', ') : 'None',
      decalIssued: !isOOS && logForm.level === 'Level 1'
    };

    setLoggedInspections([newInsp, ...loggedInspections]);
  };

  const deleteUserPin = (pinId) => {
    setUserPins(userPins.filter(p => p.id !== pinId));
    if (selectedItem?.id === pinId) setSelectedItem(null);
  };

  const togglePinStatus = (pinId) => {
    setUserPins(userPins.map(p => {
      if (p.id === pinId) {
        const nextStatus = p.status === 'Active Observation' ? 'Resolved / Cleared' : 'Active Observation';
        return { ...p, status: nextStatus };
      }
      return p;
    }));
  };

  // Filtered Roving Sites & Pins
  const filteredOfficialUnits = useMemo(() => {
    return officialUnits.filter(u => {
      const matchesSearch = u.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
                            u.unitId.toLowerCase().includes(searchQuery.toLowerCase()) ||
                            u.corridor.toLowerCase().includes(searchQuery.toLowerCase());
      const matchesCorridor = selectedCorridor === 'All' || u.corridor === selectedCorridor;
      const matchesLevel = selectedLevelFilter === 'All' || u.supportedLevels.includes(selectedLevelFilter);
      return matchesSearch && matchesCorridor && matchesLevel;
    });
  }, [officialUnits, searchQuery, selectedCorridor, selectedLevelFilter]);

  const filteredUserPins = useMemo(() => {
    return userPins.filter(p => {
      const matchesSearch = p.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
                            p.notes.toLowerCase().includes(searchQuery.toLowerCase()) ||
                            p.corridor.toLowerCase().includes(searchQuery.toLowerCase());
      const matchesCorridor = selectedCorridor === 'All' || p.corridor === selectedCorridor;
      const matchesLevel = selectedLevelFilter === 'All' || p.level.includes(selectedLevelFilter);
      return matchesSearch && matchesCorridor && matchesLevel;
    });
  }, [userPins, searchQuery, selectedCorridor, selectedLevelFilter]);

  // Execute Simulated API Endpoint Request
  const executeApiRequest = () => {
    setIsLoadingApi(true);
    setApiResponse(null);

    setTimeout(() => {
      let resData = {};
      const status = 200;

      if (apiEndpoint === '/api/v1/mobile-units') {
        const filtered = apiParamCorridor === 'All' 
          ? officialUnits 
          : officialUnits.filter(u => u.corridor === apiParamCorridor);
        resData = {
          status: "success",
          count: filtered.length,
          timestamp: new Date().toISOString(),
          data: filtered
        };
      } else if (apiEndpoint === '/api/v1/observations') {
        if (apiMethod === 'GET') {
          const filtered = apiParamCorridor === 'All'
            ? userPins
            : userPins.filter(p => p.corridor === apiParamCorridor);
          resData = {
            status: "success",
            count: filtered.length,
            timestamp: new Date().toISOString(),
            data: filtered
          };
        } else if (apiMethod === 'POST') {
          let parsed;
          try {
            parsed = JSON.parse(apiPayload);
          } catch (e) {
            parsed = { title: "New Roadside Observation", corridor: "I-70 Mountain Corridor" };
          }
          const createdPin = {
            id: `USER-PIN-${Math.floor(100 + Math.random() * 900)}`,
            isOfficial: false,
            title: parsed.title || "API Dropped Observation Pin",
            corridor: parsed.corridor || "I-70 Mountain Corridor",
            type: parsed.type || "Portable Scale Checkpoint",
            level: parsed.level || "Level 1 Full Inspection",
            scaleType: "Portable Wheel Load Weigh Pads",
            lat: parsed.lat || 39.7392,
            lng: parsed.lng || -104.9903,
            status: "Active Observation",
            reportedBy: "API_Client",
            timestamp: "Just now",
            notes: parsed.notes || "Submitted via REST API Playground",
            activeUnits: "1 Roving Patrol"
          };
          setUserPins([createdPin, ...userPins]);
          resData = {
            status: "created",
            code: 201,
            message: "Crowdsourced observation pin successfully recorded and rendered on map",
            data: createdPin
          };
        } else if (apiMethod === 'DELETE') {
          const removed = userPins[0];
          if (removed) {
            setUserPins(userPins.slice(1));
            resData = {
              status: "deleted",
              code: 200,
              message: `Observation pin ${removed.id} removed from active feed`,
              deletedId: removed.id
            };
          } else {
            resData = { status: "error", code: 404, message: "No active user observation pins available to delete" };
          }
        }
      } else if (apiEndpoint === '/api/v1/inspections') {
        resData = {
          status: "success",
          totalLoggedToday: loggedInspections.length,
          oosRate: "20.5%",
          timestamp: new Date().toISOString(),
          inspections: loggedInspections
        };
      } else if (apiEndpoint === '/api/v1/corridor-stats') {
        resData = {
          status: "success",
          corridors: [
            { name: "I-70 Mountain Corridor", activeMobileDetails: 2, oosRate: "22.4%", scaleOverloads: 6 },
            { name: "I-25 Corridor", activeMobileDetails: 1, oosRate: "18.2%", scaleOverloads: 3 },
            { name: "US-85 Corridor", activeMobileDetails: 1, oosRate: "21.0%", scaleOverloads: 4 },
            { name: "US-50 Corridor", activeMobileDetails: 1, oosRate: "15.8%", scaleOverloads: 1 }
          ],
          generatedAt: new Date().toISOString()
        };
      }

      setApiResponse({ status, data: resData });
      setIsLoadingApi(false);
    }, 400);
  };

  // Generate dynamic cURL, JS, and Python snippets
  const generatedCode = useMemo(() => {
    const fullUrl = `https://cdot.colorado.gov${apiEndpoint}${apiParamCorridor !== 'All' ? `?corridor=${encodeURIComponent(apiParamCorridor)}` : ''}`;

    if (apiLang === 'curl') {
      if (apiMethod === 'GET') {
        return `curl -X GET "${fullUrl}" \\\n  -H "Authorization: Bearer cdot_token_2026_demo" \\\n  -H "Accept: application/json"`;
      } else if (apiMethod === 'POST') {
        return `curl -X POST "${fullUrl}" \\\n  -H "Authorization: Bearer cdot_token_2026_demo" \\\n  -H "Content-Type: application/json" \\\n  -d '${apiPayload.replace(/\n/g, '')}'`;
      } else {
        return `curl -X DELETE "${fullUrl}/USER-PIN-801" \\\n  -H "Authorization: Bearer cdot_token_2026_demo"`;
      }
    } else if (apiLang === 'js') {
      if (apiMethod === 'GET') {
        return `// JavaScript Fetch API Example
fetch("${fullUrl}", {
  method: "GET",
  headers: {
    "Authorization": "Bearer cdot_token_2026_demo",
    "Accept": "application/json"
  }
})
.then(res => res.json())
.then(data => console.log("CDOT Telemetry:", data))
.catch(err => console.error(err));`;
      } else if (apiMethod === 'POST') {
        return `// JavaScript Fetch POST Observation
fetch("${fullUrl}", {
  method: "POST",
  headers: {
    "Authorization": "Bearer cdot_token_2026_demo",
    "Content-Type": "application/json"
  },
  body: JSON.stringify(${apiPayload})
})
.then(res => res.json())
.then(data => console.log("Pin Created:", data));`;
      } else {
        return `// JavaScript Fetch DELETE
fetch("${fullUrl}/USER-PIN-801", {
  method: "DELETE",
  headers: { "Authorization": "Bearer cdot_token_2026_demo" }
})
.then(res => res.json())
.then(data => console.log("Deleted:", data));`;
      }
    } else if (apiLang === 'python') {
      if (apiMethod === 'GET') {
        return `# Python Requests Library Example
import requests

url = "${fullUrl}"
headers = {
    "Authorization": "Bearer cdot_token_2026_demo",
    "Accept": "application/json"
}

response = requests.get(url, headers=headers)
print("Status Code:", response.status_code)
print("Response JSON:", response.json())`;
      } else if (apiMethod === 'POST') {
        return `# Python Requests POST Example
import requests

url = "${fullUrl}"
headers = {
    "Authorization": "Bearer cdot_token_2026_demo",
    "Content-Type": "application/json"
}
payload = ${apiPayload}

response = requests.post(url, headers=headers, json=payload)
print("Created Pin Data:", response.json())`;
      } else {
        return `# Python Requests DELETE Example
import requests

url = "${fullUrl}/USER-PIN-801"
headers = {"Authorization": "Bearer cdot_token_2026_demo"}

response = requests.delete(url, headers=headers)
print("Response:", response.json())`;
      }
    }
  }, [apiEndpoint, apiMethod, apiLang, apiParamCorridor, apiPayload]);

  const copyToClipboard = (text) => {
    navigator.clipboard.writeText(text);
    setCopiedCode(true);
    setTimeout(() => setCopiedCode(false), 2000);
  };

  return (
    <div className={`min-h-screen ${theme === 'dark' ? 'bg-slate-950 text-slate-100' : 'bg-slate-50 text-slate-900'} font-sans flex flex-col`}>
      
      {/* Navigation Header */}
      <header className="border-b border-slate-800 bg-slate-900/90 backdrop-blur-md sticky top-0 z-50 px-4 py-3 flex items-center justify-between shadow-xl">
        <div className="flex items-center gap-3">
          <div className="bg-gradient-to-tr from-cyan-600 via-blue-600 to-indigo-600 p-2.5 rounded-xl shadow-lg shadow-cyan-500/20">
            <Truck className="w-6 h-6 text-white animate-pulse" />
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-tight bg-gradient-to-r from-cyan-400 via-blue-300 to-indigo-300 bg-clip-text text-transparent flex items-center gap-2">
              CDOT & CSP Non-Fixed Inspection Dashboard
              <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-950 text-emerald-400 border border-emerald-800">
                LIVE MOBILE OPS
              </span>
            </h1>
            <p className="text-xs text-slate-400">Roving CSP Carrier Enforcement & Crowdsourced Roadside Observation Network</p>
          </div>
        </div>

        {/* Navigation Tabs */}
        <div className="hidden md:flex items-center gap-1 bg-slate-950/80 p-1 rounded-lg border border-slate-800">
          {[
            { id: 'map', label: 'Roving Operations Map', icon: MapPin },
            { id: 'userPins', label: 'Crowdsourced Pins', icon: Radio, badge: userPins.length },
            { id: 'logger', label: 'CVSA Inspection Logger', icon: ClipboardList },
            { id: 'guide', label: 'Level 1-5 Standards Guide', icon: Award },
            { id: 'analytics', label: 'Enforcement Analytics', icon: BarChart2 },
            { id: 'api', label: 'API Playground', icon: Terminal }
          ].map(tab => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold transition-all ${
                  activeTab === tab.id
                    ? 'bg-gradient-to-r from-cyan-600 to-blue-600 text-white shadow'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                {tab.label}
                {tab.badge !== undefined && (
                  <span className="px-1.5 py-0.2 rounded-full bg-pink-950 text-pink-400 border border-pink-800 text-[10px] font-mono">
                    {tab.badge}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Header Actions */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => {
              setActiveTab('map');
              setIsDropPinMode(!isDropPinMode);
            }}
            className={`px-3 py-1.5 rounded-lg text-xs font-bold transition flex items-center gap-1.5 shadow-lg ${
              isDropPinMode
                ? 'bg-pink-600 text-white animate-pulse'
                : 'bg-gradient-to-r from-pink-600 to-purple-600 hover:from-pink-500 hover:to-purple-500 text-white'
            }`}
          >
            <Crosshair className="w-4 h-4" />
            {isDropPinMode ? 'Cancel Pin Mode' : 'Drop Observation Pin'}
          </button>

          <button 
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 transition"
          >
            {theme === 'dark' ? <Sun className="w-4 h-4 text-amber-400" /> : <Moon className="w-4 h-4 text-slate-400" />}
          </button>
        </div>
      </header>

      {/* Main Container */}
      <main className="flex-1 p-4 max-w-7xl w-full mx-auto grid grid-cols-1 lg:grid-cols-12 gap-4">
        
        {/* TAB 1: ROVING OPERATIONS MAP & DROP PIN MODE */}
        {activeTab === 'map' && (
          <>
            {/* Map Area (8 Cols) */}
            <div className="lg:col-span-8 flex flex-col gap-3 h-[680px]">
              {/* Search & Filter Control Bar */}
              <div className="flex flex-wrap items-center justify-between gap-2 bg-slate-900/80 p-2.5 rounded-xl border border-slate-800 text-xs">
                <div className="flex items-center gap-2 flex-1 min-w-[200px]">
                  <Search className="w-4 h-4 text-slate-400" />
                  <input
                    type="text"
                    placeholder="Search mobile detail, corridor, or user pin..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="bg-transparent border-none outline-none text-slate-200 placeholder-slate-500 w-full text-xs"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <select 
                    value={selectedCorridor}
                    onChange={(e) => setSelectedCorridor(e.target.value)}
                    className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-slate-300 text-xs outline-none"
                  >
                    <option value="All">All Corridors</option>
                    <option value="I-70 Mountain Corridor">I-70 Mountain Corridor</option>
                    <option value="I-25 Corridor">I-25 Corridor</option>
                    <option value="US-85 Corridor">US-85 Corridor</option>
                    <option value="US-50 Corridor">US-50 Corridor</option>
                  </select>
                  <select 
                    value={selectedLevelFilter}
                    onChange={(e) => setSelectedLevelFilter(e.target.value)}
                    className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-slate-300 text-xs outline-none"
                  >
                    <option value="All">All Inspection Levels</option>
                    <option value="Level 1">Level 1 (Full)</option>
                    <option value="Level 2">Level 2 (Walk-around)</option>
                    <option value="Level 3">Level 3 (Driver/ELD)</option>
                    <option value="Level 4">Level 4 (Special)</option>
                    <option value="Level 5">Level 5 (Vehicle)</option>
                  </select>
                </div>
              </div>

              {/* Interactive Map */}
              <div className="flex-1 relative">
                <LeafletMobileMap 
                  officialUnits={filteredOfficialUnits}
                  userPins={filteredUserPins}
                  selectedPin={selectedItem}
                  onSelectPin={(item) => setSelectedItem(item)}
                  isDropPinMode={isDropPinMode}
                  onMapClickForPin={handleMapClickForPin}
                />
              </div>
            </div>

            {/* Selected Item Detail Sidebar (4 Cols) */}
            <div className="lg:col-span-4 space-y-4">
              {selectedItem ? (
                <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-4 shadow-xl space-y-4">
                  <div className="border-b border-slate-800 pb-3 flex justify-between items-start">
                    <div>
                      <span className="text-[10px] font-mono text-cyan-400 font-bold uppercase tracking-wider">
                        {selectedItem.isOfficial ? selectedItem.unitId : `CROWDSOURCED PIN (${selectedItem.id})`}
                      </span>
                      <h2 className="text-base font-bold text-slate-100">{selectedItem.name || selectedItem.title}</h2>
                      <p className="text-xs text-slate-400">{selectedItem.corridor}</p>
                    </div>
                    <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                      selectedItem.isOfficial 
                        ? 'bg-emerald-950 text-emerald-400 border border-emerald-800'
                        : 'bg-pink-950 text-pink-400 border border-pink-800'
                    }`}>
                      {selectedItem.type}
                    </span>
                  </div>

                  {/* Operational Details */}
                  {selectedItem.isOfficial ? (
                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <div className="bg-slate-950 p-2.5 rounded-lg border border-slate-800">
                        <div className="text-[10px] text-slate-400">Troopers Assigned</div>
                        <div className="text-sm font-bold text-slate-100 font-mono">{selectedItem.troopers} Officers</div>
                      </div>
                      <div className="bg-slate-950 p-2.5 rounded-lg border border-slate-800">
                        <div className="text-[10px] text-slate-400">Inspections Today</div>
                        <div className="text-sm font-bold text-cyan-400 font-mono">{selectedItem.inspectionsToday}</div>
                      </div>
                      <div className="bg-slate-950 p-2.5 rounded-lg border border-slate-800">
                        <div className="text-[10px] text-slate-400">Out of Service (OOS)</div>
                        <div className="text-sm font-bold text-red-400 font-mono">{selectedItem.oosCount} Vehicles</div>
                      </div>
                      <div className="bg-slate-950 p-2.5 rounded-lg border border-slate-800">
                        <div className="text-[10px] text-slate-400">Portable Scales</div>
                        <div className="text-sm font-bold text-emerald-400 font-mono">
                          {selectedItem.portableScaleActive ? 'Active pad' : 'Inactive'}
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-2 text-xs">
                      <div className="bg-slate-950 p-3 rounded-lg border border-slate-800 space-y-1">
                        <div className="text-[10px] text-pink-400 font-bold uppercase">User Observation Info</div>
                        <div>Inspection Level: <b>{selectedItem.level}</b></div>
                        <div>Equipment: <b>{selectedItem.scaleType}</b></div>
                        <div>Active Units: <b>{selectedItem.activeUnits}</b></div>
                        <div>Reported By: <b>{selectedItem.reportedBy} ({selectedItem.timestamp})</b></div>
                      </div>
                      <div className="bg-slate-800/40 p-3 rounded-lg border border-slate-700/50">
                        <div className="text-[10px] text-slate-400 font-bold uppercase mb-1">Observation Remarks</div>
                        <p className="text-slate-300 font-serif italic">"{selectedItem.notes}"</p>
                      </div>
                    </div>
                  )}

                  {selectedItem.details && (
                    <div className="bg-slate-800/40 p-3 rounded-lg border border-slate-700/50 space-y-1">
                      <span className="text-[10px] text-slate-400 uppercase font-semibold">Operational Focus</span>
                      <p className="text-xs text-slate-300 leading-relaxed">{selectedItem.details}</p>
                    </div>
                  )}

                  {!selectedItem.isOfficial && (
                    <div className="flex gap-2">
                      <button 
                        onClick={() => togglePinStatus(selectedItem.id)}
                        className="flex-1 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg text-xs font-semibold border border-slate-700 transition"
                      >
                        {selectedItem.status === 'Active Observation' ? 'Mark Resolved' : 'Mark Active'}
                      </button>
                      <button 
                        onClick={() => deleteUserPin(selectedItem.id)}
                        className="p-2 bg-red-950 hover:bg-red-900 text-red-300 rounded-lg text-xs font-semibold border border-red-800 transition"
                        title="Delete Pin"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  )}

                  <button 
                    onClick={() => setActiveTab('logger')}
                    className="w-full py-2.5 bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white rounded-lg text-xs font-bold shadow flex items-center justify-center gap-2 transition"
                  >
                    <PlusCircle className="w-4 h-4" />
                    Log Inspection for This Location
                  </button>
                </div>
              ) : (
                <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-8 text-center text-slate-500 text-xs">
                  Select an official station or crowdsourced pin on the map to inspect operational status.
                </div>
              )}
            </div>
          </>
        )}

        {/* TAB 2: CROWDSOURCED OBSERVATION PINS MANAGER */}
        {activeTab === 'userPins' && (
          <div className="lg:col-span-12 space-y-4">
            <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-5 shadow-xl space-y-4">
              <div className="flex justify-between items-center border-b border-slate-800 pb-3">
                <div>
                  <h2 className="text-base font-bold text-slate-100 flex items-center gap-2">
                    <Radio className="w-5 h-5 text-pink-400" />
                    Crowdsourced Roadside Inspection Observations
                  </h2>
                  <p className="text-xs text-slate-400">User-submitted non-fixed scale checkpoints and roving details</p>
                </div>
                <button
                  onClick={() => {
                    setActiveTab('map');
                    setIsDropPinMode(true);
                  }}
                  className="px-3 py-2 bg-gradient-to-r from-pink-600 to-purple-600 hover:from-pink-500 hover:to-purple-500 text-white rounded-lg text-xs font-bold flex items-center gap-1.5 shadow"
                >
                  <Plus className="w-4 h-4" />
                  Drop New Pin on Map
                </button>
              </div>

              {/* User Pins Grid */}
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {filteredUserPins.map((pin) => (
                  <div key={pin.id} className="bg-slate-950 border border-slate-800 rounded-xl p-4 space-y-3 flex flex-col justify-between hover:border-pink-500/40 transition">
                    <div>
                      <div className="flex justify-between items-start mb-2">
                        <span className="font-mono text-pink-400 font-bold text-xs">{pin.id}</span>
                        <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                          pin.status === 'Active Observation'
                            ? 'bg-pink-950 text-pink-400 border border-pink-800'
                            : 'bg-slate-800 text-slate-400 border border-slate-700'
                        }`}>
                          {pin.status}
                        </span>
                      </div>
                      <h3 className="text-sm font-bold text-slate-100 mb-1">{pin.title}</h3>
                      <p className="text-xs text-slate-400 mb-2">{pin.corridor}</p>
                      
                      <div className="bg-slate-900/80 p-2.5 rounded-lg border border-slate-800 text-xs space-y-1 mb-2">
                        <div><span className="text-slate-400">Type:</span> <b>{pin.type}</b></div>
                        <div><span className="text-slate-400">Level:</span> <b>{pin.level}</b></div>
                        <div><span className="text-slate-400">Scales:</span> <b>{pin.scaleType}</b></div>
                      </div>

                      <p className="text-xs text-slate-300 italic bg-slate-900/40 p-2 rounded border border-slate-800">
                        "{pin.notes}"
                      </p>
                    </div>

                    <div className="border-t border-slate-800 pt-3 flex items-center justify-between text-xs">
                      <span className="text-[10px] text-slate-500">{pin.timestamp} by {pin.reportedBy}</span>
                      <div className="flex gap-1">
                        <button
                          onClick={() => {
                            setSelectedItem(pin);
                            setActiveTab('map');
                          }}
                          className="px-2 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded text-[11px]"
                        >
                          View Map
                        </button>
                        <button
                          onClick={() => deleteUserPin(pin.id)}
                          className="p-1 text-red-400 hover:bg-red-950/50 rounded"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* TAB 3: DIGITAL CVSA LEVEL 1-5 INSPECTION FORM */}
        {activeTab === 'logger' && (
          <div className="lg:col-span-12 space-y-4">
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
              
              {/* Form Input Column (7 Cols) */}
              <div className="lg:col-span-7 bg-slate-900/90 border border-slate-800 rounded-xl p-5 shadow-xl space-y-4">
                <div className="border-b border-slate-800 pb-3 flex justify-between items-center">
                  <div>
                    <h2 className="text-base font-bold text-slate-100 flex items-center gap-2">
                      <ClipboardList className="w-5 h-5 text-cyan-400" />
                      Digital Roadside CVSA Inspection Logger
                    </h2>
                    <p className="text-xs text-slate-400">Record Level 1–5 roadside inspection outcome</p>
                  </div>
                  <span className="text-xs font-mono bg-slate-950 px-2 py-1 rounded border border-slate-800 text-cyan-400">
                    FORM-CVSA-2026
                  </span>
                </div>

                <form onSubmit={handleLogSubmit} className="space-y-4 text-xs">
                  {/* Scope & Level Selection */}
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-slate-400 mb-1 font-semibold">Inspection Level Target</label>
                      <select 
                        value={logForm.level}
                        onChange={(e) => setLogForm({...logForm, level: e.target.value})}
                        className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2 text-slate-200 outline-none focus:border-cyan-500 font-medium"
                      >
                        <option value="Level 1">Level 1 - Full Vehicle & Driver Inspection</option>
                        <option value="Level 2">Level 2 - Walk-Around Driver & Vehicle</option>
                        <option value="Level 3">Level 3 - Driver Credentials & ELD Log</option>
                        <option value="Level 4">Level 4 - Special Component Inspection</option>
                        <option value="Level 5">Level 5 - Vehicle-Only Mechanical Audit</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-slate-400 mb-1 font-semibold">Roadside Location / Corridor</label>
                      <input 
                        type="text" 
                        value={logForm.location}
                        onChange={(e) => setLogForm({...logForm, location: e.target.value})}
                        className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2 text-slate-200 outline-none focus:border-cyan-500"
                      />
                    </div>
                  </div>

                  {/* USDOT & Carrier Info */}
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-slate-400 mb-1 font-semibold">USDOT / MC Number</label>
                      <input 
                        type="text" 
                        value={logForm.usdot}
                        onChange={(e) => setLogForm({...logForm, usdot: e.target.value})}
                        className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2 text-slate-200 font-mono outline-none focus:border-cyan-500"
                      />
                    </div>
                    <div>
                      <label className="block text-slate-400 mb-1 font-semibold">Motor Carrier Name</label>
                      <input 
                        type="text" 
                        value={logForm.carrierName}
                        onChange={(e) => setLogForm({...logForm, carrierName: e.target.value})}
                        className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2 text-slate-200 outline-none focus:border-cyan-500"
                      />
                    </div>
                  </div>

                  {/* Out-Of-Service Determination Checkboxes */}
                  <div className="bg-slate-950 p-3.5 rounded-xl border border-slate-800 space-y-2">
                    <span className="text-xs font-bold text-amber-400 flex items-center gap-1.5">
                      <AlertTriangle className="w-4 h-4" />
                      Critical Out-Of-Service (OOS) Violation Checklist
                    </span>
                    <div className="grid grid-cols-2 gap-2 text-slate-300">
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input 
                          type="checkbox" 
                          checked={logForm.brakesOOS}
                          onChange={(e) => setLogForm({...logForm, brakesOOS: e.target.checked})}
                          className="rounded bg-slate-900 border-slate-700 text-cyan-500 focus:ring-0"
                        />
                        <span>Brake Adjustment &gt;20% Limits</span>
                      </label>
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input 
                          type="checkbox" 
                          checked={logForm.tiresOOS}
                          onChange={(e) => setLogForm({...logForm, tiresOOS: e.target.checked})}
                          className="rounded bg-slate-900 border-slate-700 text-cyan-500 focus:ring-0"
                        />
                        <span>Tire Ply Exposure / Flat Tire</span>
                      </label>
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input 
                          type="checkbox" 
                          checked={logForm.eldOOS}
                          onChange={(e) => setLogForm({...logForm, eldOOS: e.target.checked})}
                          className="rounded bg-slate-900 border-slate-700 text-cyan-500 focus:ring-0"
                        />
                        <span>Hours-of-Service / ELD Violation</span>
                      </label>
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input 
                          type="checkbox" 
                          checked={logForm.weightOverload}
                          onChange={(e) => setLogForm({...logForm, weightOverload: e.target.checked})}
                          className="rounded bg-slate-900 border-slate-700 text-cyan-500 focus:ring-0"
                        />
                        <span>Portable Scale Axle Overload</span>
                      </label>
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input 
                          type="checkbox" 
                          checked={logForm.steeringOOS}
                          onChange={(e) => setLogForm({...logForm, steeringOOS: e.target.checked})}
                          className="rounded bg-slate-900 border-slate-700 text-cyan-500 focus:ring-0"
                        />
                        <span>Steering Mechanism / Frame Crack</span>
                      </label>
                    </div>
                  </div>

                  {/* Notes */}
                  <div>
                    <label className="block text-slate-400 mb-1 font-semibold">Inspector Remarks & Decal Recommendation</label>
                    <textarea 
                      rows="2" 
                      value={logForm.notes}
                      onChange={(e) => setLogForm({...logForm, notes: e.target.value})}
                      className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2 text-slate-200 outline-none focus:border-cyan-500 text-xs"
                    />
                  </div>

                  <button 
                    type="submit"
                    className="w-full py-2.5 bg-gradient-to-r from-emerald-600 to-cyan-600 hover:from-emerald-500 hover:to-cyan-500 text-white rounded-lg font-bold shadow text-xs transition"
                  >
                    Submit & Log Inspection Record
                  </button>
                </form>
              </div>

              {/* Logged Inspection Feed (5 Cols) */}
              <div className="lg:col-span-5 space-y-3">
                <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-4 shadow-xl">
                  <h3 className="text-sm font-bold text-slate-100 mb-3 flex items-center justify-between">
                    <span>Recent Roadside Inspection Log</span>
                    <span className="text-[10px] font-mono text-cyan-400">{loggedInspections.length} Records</span>
                  </h3>
                  
                  <div className="space-y-2.5 max-h-[500px] overflow-y-auto pr-1">
                    {loggedInspections.map((insp) => (
                      <div key={insp.id} className="bg-slate-950 p-3 rounded-lg border border-slate-800 space-y-1.5">
                        <div className="flex justify-between items-start">
                          <div>
                            <span className="text-[10px] font-mono text-cyan-400 font-bold">{insp.id}</span>
                            <div className="font-bold text-xs text-slate-200">{insp.carrier}</div>
                            <div className="text-[10px] text-slate-400">{insp.usdot} • {insp.location}</div>
                          </div>
                          <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                            insp.status === 'Passed' 
                              ? 'bg-emerald-950 text-emerald-400 border border-emerald-800' 
                              : 'bg-red-950 text-red-400 border border-red-800'
                          }`}>
                            {insp.status}
                          </span>
                        </div>

                        {insp.status !== 'Passed' && (
                          <div className="text-[10px] text-red-400 bg-red-950/40 p-1.5 rounded border border-red-900/50">
                            <b>OOS Reason:</b> {insp.oosReason}
                          </div>
                        )}

                        {insp.decalIssued && (
                          <div className="flex items-center gap-1 text-[10px] text-emerald-400">
                            <Award className="w-3.5 h-3.5 text-amber-400" />
                            CVSA Decal Issued (Valid 3 Months)
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              </div>

            </div>
          </div>
        )}

        {/* TAB 4: CVSA LEVEL 1-5 STANDARDS GUIDE */}
        {activeTab === 'guide' && (
          <div className="lg:col-span-12 space-y-4">
            <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-5 shadow-xl space-y-4">
              <div className="border-b border-slate-800 pb-3">
                <h2 className="text-base font-bold text-slate-100 flex items-center gap-2">
                  <Award className="w-5 h-5 text-cyan-400" />
                  CVSA Commercial Vehicle Safety Inspection Levels Quick Reference
                </h2>
                <p className="text-xs text-slate-400">Official scope, required mechanical checks, and Out-Of-Service criteria</p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {[
                  {
                    level: 'Level 1',
                    title: 'North American Standard Inspection',
                    time: '45-60 mins',
                    scope: 'Most comprehensive inspection. Includes full under-vehicle chassis inspection, steering, brakes, suspension, driver credentials, and ELD logbook.',
                    checks: ['Brake System Adjustment', 'Coupling Devices', 'Fuel System & Exhaust', 'Steering Mechanism', 'Driver ELD & Medical Cert'],
                    oosRule: '20% or more of service brakes inoperative = Out of Service.'
                  },
                  {
                    level: 'Level 2',
                    title: 'Walk-Around Driver & Vehicle Inspection',
                    time: '25-30 mins',
                    scope: 'Includes all items checked in Level 1 without physically crawling underneath the vehicle chassis.',
                    checks: ['Outer Wheel & Tire Condition', 'Lighting & Placards', 'Driver License & Medical', 'Load Securement'],
                    oosRule: 'Flat tire or exposed ply cord = Immediate OOS.'
                  },
                  {
                    level: 'Level 3',
                    title: 'Driver Credentials & Administrative Inspection',
                    time: '15-20 mins',
                    scope: 'Focused purely on driver compliance, Electronic Logging Device (ELD) hours-of-service, license class, and hazmat endorsements.',
                    checks: ['Commercial Driver License (CDL)', 'Medical Examiner Cert', 'RODS / Hours of Service', 'Seat Belt Compliance'],
                    oosRule: 'HOS false log or exceeded driving window = 10hr-34hr OOS.'
                  },
                  {
                    level: 'Level 4',
                    title: 'Special Targeted Component Inspection',
                    time: '10-15 mins',
                    scope: 'One-time study or targeted enforcement on a specific component (e.g., brake adjustment campaign or chain law enforcement).',
                    checks: ['Targeted Axle Brakes', 'Snow Chain Tread Depth', 'Agricultural Placards'],
                    oosRule: 'Non-compliance with targeted bulletin.'
                  },
                  {
                    level: 'Level 5',
                    title: 'Vehicle-Only Inspection (No Driver Present)',
                    time: '30-40 mins',
                    scope: 'Full mechanical check of vehicle components at a terminal or carrier facility without the driver present.',
                    checks: ['Chassis & Frame Integrity', 'Brake System Mechanics', 'Tires & Wheels', 'Exhaust System'],
                    oosRule: 'Chassis crack or major brake failure.'
                  }
                ].map((item) => (
                  <div key={item.level} className="bg-slate-950 border border-slate-800 rounded-xl p-4 space-y-3 flex flex-col justify-between">
                    <div>
                      <div className="flex justify-between items-center mb-1">
                        <span className="font-mono text-cyan-400 font-bold text-sm">{item.level}</span>
                        <span className="text-[10px] font-mono text-slate-500 bg-slate-900 px-2 py-0.5 rounded">{item.time}</span>
                      </div>
                      <h3 className="text-xs font-bold text-slate-200 mb-2">{item.title}</h3>
                      <p className="text-xs text-slate-400 leading-relaxed mb-3">{item.scope}</p>
                      
                      <div className="space-y-1">
                        <span className="text-[10px] font-semibold text-slate-300 uppercase">Key Checklist Items:</span>
                        <ul className="text-xs text-slate-400 space-y-0.5 list-disc list-inside">
                          {item.checks.map(c => <li key={c}>{c}</li>)}
                        </ul>
                      </div>
                    </div>

                    <div className="bg-red-950/30 border border-red-900/40 p-2 rounded text-[11px] text-red-300 mt-2">
                      <span className="font-bold">OOS Rule:</span> {item.oosRule}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* TAB 5: ENFORCEMENT ANALYTICS */}
        {activeTab === 'analytics' && (
          <div className="lg:col-span-12 space-y-4">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-3.5 space-y-1">
                <span className="text-xs text-slate-400 font-medium">Active Roving Units</span>
                <div className="text-xl font-bold font-mono text-emerald-400">8 Squads</div>
                <span className="text-[10px] text-slate-500">I-70, I-25, US-85, US-50</span>
              </div>
              <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-3.5 space-y-1">
                <span className="text-xs text-slate-400 font-medium">Inspections Today</span>
                <div className="text-xl font-bold font-mono text-cyan-400">102 Vehicles</div>
                <span className="text-[10px] text-slate-500">+18% vs weekly average</span>
              </div>
              <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-3.5 space-y-1">
                <span className="text-xs text-slate-400 font-medium">Out-of-Service Rate</span>
                <div className="text-xl font-bold font-mono text-red-400">20.5% OOS</div>
                <span className="text-[10px] text-slate-500">Top cause: Brake Adjustment</span>
              </div>
              <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-3.5 space-y-1">
                <span className="text-xs text-slate-400 font-medium">Scale Overloads Detected</span>
                <div className="text-xl font-bold font-mono text-amber-400">12 Overloads</div>
                <span className="text-[10px] text-slate-500">Portable pad weighings</span>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <SimpleTrendChart 
                title="Hourly Roadside Inspection Volume" 
                unit="insps/hr" 
                color="#06b6d4" 
                data={[4, 8, 15, 22, 18, 12, 16]} 
              />
              <SimpleTrendChart 
                title="Out-Of-Service Violation Trend (%)" 
                unit="%" 
                color="#ef4444" 
                data={[12, 18, 25, 22, 19, 20.5]} 
              />
              <SimpleTrendChart 
                title="Portable Scale Weight Detections" 
                unit="tons avg" 
                color="#f59e0b" 
                data={[38, 41, 44, 39, 42, 45]} 
              />
            </div>
          </div>
        )}

        {/* TAB 6: API PLAYGROUND & ENDPOINT SIMULATOR */}
        {activeTab === 'api' && (
          <div className="lg:col-span-12 space-y-4">
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
              
              {/* Endpoint Request Configuration Panel (6 Cols) */}
              <div className="lg:col-span-6 bg-slate-900/90 border border-slate-800 rounded-xl p-5 shadow-xl space-y-4">
                <div className="border-b border-slate-800 pb-3 flex justify-between items-center">
                  <div>
                    <h2 className="text-base font-bold text-slate-100 flex items-center gap-2">
                      <Terminal className="w-5 h-5 text-cyan-400" />
                      CDOT Telemetry REST API Playground
                    </h2>
                    <p className="text-xs text-slate-400">Test live simulated mobile operations and crowdsourced observation endpoints</p>
                  </div>
                  <span className="text-xs font-mono bg-emerald-950 text-emerald-400 border border-emerald-800 px-2 py-0.5 rounded">
                    v1.0-ONLINE
                  </span>
                </div>

                {/* HTTP Method & Endpoint Selector */}
                <div className="space-y-3">
                  <div>
                    <label className="block text-slate-400 text-xs mb-1 font-semibold">Endpoint Route</label>
                    <div className="flex gap-2">
                      <select 
                        value={apiMethod} 
                        onChange={(e) => setApiMethod(e.target.value)}
                        className={`px-3 py-2 rounded-lg font-mono font-bold text-xs border outline-none ${
                          apiMethod === 'GET' ? 'bg-emerald-950 text-emerald-400 border-emerald-800' :
                          apiMethod === 'POST' ? 'bg-cyan-950 text-cyan-400 border-cyan-800' :
                          'bg-red-950 text-red-400 border-red-800'
                        }`}
                      >
                        <option value="GET">GET</option>
                        <option value="POST">POST</option>
                        <option value="DELETE">DELETE</option>
                      </select>

                      <select 
                        value={apiEndpoint} 
                        onChange={(e) => setApiEndpoint(e.target.value)}
                        className="flex-1 bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-slate-200 font-mono text-xs outline-none focus:border-cyan-500"
                      >
                        <option value="/api/v1/observations">/api/v1/observations (Crowdsourced Pins)</option>
                        <option value="/api/v1/mobile-units">/api/v1/mobile-units (Official CSP Squads)</option>
                        <option value="/api/v1/inspections">/api/v1/inspections (Logged CVSA Audits)</option>
                        <option value="/api/v1/corridor-stats">/api/v1/corridor-stats (Highway Metrics)</option>
                      </select>
                    </div>
                  </div>

                  {/* Filter Query Param */}
                  <div>
                    <label className="block text-slate-400 text-xs mb-1 font-semibold">Filter Parameter (?corridor)</label>
                    <select 
                      value={apiParamCorridor}
                      onChange={(e) => setApiParamCorridor(e.target.value)}
                      className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2 text-slate-200 text-xs outline-none focus:border-cyan-500"
                    >
                      <option value="All">All Corridors</option>
                      <option value="I-70 Mountain Corridor">I-70 Mountain Corridor</option>
                      <option value="I-25 Corridor">I-25 Corridor</option>
                      <option value="US-85 Corridor">US-85 Corridor</option>
                      <option value="US-50 Corridor">US-50 Corridor</option>
                    </select>
                  </div>

                  {/* POST Payload Input */}
                  {apiMethod === 'POST' && (
                    <div>
                      <label className="block text-slate-400 text-xs mb-1 font-semibold">POST Payload (JSON Body)</label>
                      <textarea 
                        rows="6"
                        value={apiPayload}
                        onChange={(e) => setApiPayload(e.target.value)}
                        className="w-full bg-slate-950 font-mono text-xs text-pink-300 border border-slate-800 rounded-lg p-2.5 outline-none focus:border-cyan-500"
                      />
                    </div>
                  )}

                  <button
                    onClick={executeApiRequest}
                    disabled={isLoadingApi}
                    className="w-full py-2.5 bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white font-bold rounded-lg text-xs shadow flex items-center justify-center gap-2 transition"
                  >
                    {isLoadingApi ? (
                      <RefreshCw className="w-4 h-4 animate-spin text-white" />
                    ) : (
                      <Send className="w-4 h-4" />
                    )}
                    Send Simulated Request
                  </button>
                </div>

                {/* Simulated Response JSON Output */}
                {apiResponse && (
                  <div className="bg-slate-950 border border-slate-800 rounded-xl p-3 space-y-2">
                    <div className="flex justify-between items-center text-xs font-mono border-b border-slate-800 pb-2">
                      <span className="text-slate-400">Response Code:</span>
                      <span className="text-emerald-400 font-bold">{apiResponse.status} OK</span>
                    </div>
                    <pre className="text-[11px] font-mono text-cyan-300 bg-slate-900 p-2.5 rounded max-h-52 overflow-auto">
                      {JSON.stringify(apiResponse.data, null, 2)}
                    </pre>
                  </div>
                )}
              </div>

              {/* Live Code Generator Panel (6 Cols) */}
              <div className="lg:col-span-6 bg-slate-900/90 border border-slate-800 rounded-xl p-5 shadow-xl space-y-4">
                <div className="border-b border-slate-800 pb-3 flex justify-between items-center">
                  <div>
                    <h3 className="text-sm font-bold text-slate-100 flex items-center gap-2">
                      <Code className="w-4 h-4 text-cyan-400" />
                      Dynamic Code Generator
                    </h3>
                    <p className="text-xs text-slate-400">Copy pre-formatted client code for integration</p>
                  </div>

                  {/* Language Switcher */}
                  <div className="flex bg-slate-950 p-1 rounded-lg border border-slate-800 text-xs">
                    {['curl', 'js', 'python'].map(lang => (
                      <button
                        key={lang}
                        onClick={() => setApiLang(lang)}
                        className={`px-2.5 py-1 rounded font-mono font-bold uppercase transition ${
                          apiLang === lang ? 'bg-cyan-600 text-white' : 'text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        {lang}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="relative">
                  <pre className="bg-slate-950 border border-slate-800 text-emerald-300 font-mono text-xs p-4 rounded-xl overflow-x-auto min-h-[300px] leading-relaxed">
                    {generatedCode}
                  </pre>
                  <button
                    onClick={() => copyToClipboard(generatedCode)}
                    className="absolute top-3 right-3 p-2 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg border border-slate-700 text-xs flex items-center gap-1.5 transition shadow"
                  >
                    {copiedCode ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                    {copiedCode ? 'Copied!' : 'Copy Code'}
                  </button>
                </div>
              </div>

            </div>
          </div>
        )}

      </main>

      {/* CROWDSOURCED DROP PIN SUBMISSION MODAL */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-md flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 max-w-md w-full shadow-2xl space-y-4">
            <div className="flex justify-between items-center border-b border-slate-800 pb-3">
              <h3 className="text-sm font-bold text-slate-100 flex items-center gap-2">
                <MapPin className="w-4 h-4 text-pink-400" />
                Submit Crowdsourced Roadside Observation
              </h3>
              <button onClick={() => setIsModalOpen(false)} className="text-slate-400 hover:text-slate-200">
                <X className="w-4 h-4" />
              </button>
            </div>

            {pendingCoords && (
              <div className="bg-slate-950 p-2 rounded border border-slate-800 text-[11px] font-mono text-slate-400">
                Coordinates: <span className="text-pink-400 font-bold">{pendingCoords.lat.toFixed(4)}, {pendingCoords.lng.toFixed(4)}</span>
              </div>
            )}

            <form onSubmit={handlePinFormSubmit} className="space-y-3 text-xs">
              <div>
                <label className="block text-slate-400 mb-1 font-semibold">Location Title / Landmark</label>
                <input 
                  type="text" 
                  placeholder="e.g. I-70 EB MP 238 Idaho Springs Pullout"
                  value={newPinForm.title}
                  onChange={(e) => setNewPinForm({...newPinForm, title: e.target.value})}
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2 text-slate-200 outline-none focus:border-pink-500"
                  required
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-slate-400 mb-1 font-semibold">Corridor</label>
                  <select 
                    value={newPinForm.corridor}
                    onChange={(e) => setNewPinForm({...newPinForm, corridor: e.target.value})}
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2 text-slate-200 outline-none focus:border-pink-500"
                  >
                    <option value="I-70 Mountain Corridor">I-70 Mountain Corridor</option>
                    <option value="I-25 Corridor">I-25 Corridor</option>
                    <option value="US-85 Corridor">US-85 Corridor</option>
                    <option value="US-50 Corridor">US-50 Corridor</option>
                    <option value="I-76 Corridor">I-76 Corridor</option>
                  </select>
                </div>

                <div>
                  <label className="block text-slate-400 mb-1 font-semibold">Observation Type</label>
                  <select 
                    value={newPinForm.type}
                    onChange={(e) => setNewPinForm({...newPinForm, type: e.target.value})}
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2 text-slate-200 outline-none focus:border-pink-500"
                  >
                    <option value="Portable Scale Checkpoint">Portable Scale Checkpoint</option>
                    <option value="Roving Patrol Spot">Roving Patrol Spot</option>
                    <option value="Mountain Chain Sweep">Mountain Chain Sweep</option>
                    <option value="Roadside OOS Holding Area">Roadside OOS Holding Area</option>
                    <option value="Spot Safety Check">Spot Safety Check</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-slate-400 mb-1 font-semibold">Observed Level</label>
                  <select 
                    value={newPinForm.level}
                    onChange={(e) => setNewPinForm({...newPinForm, level: e.target.value})}
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2 text-slate-200 outline-none focus:border-pink-500"
                  >
                    <option value="Level 1 Full Vehicle & Driver">Level 1 Full Inspection</option>
                    <option value="Level 2 Walk-around">Level 2 Walk-around</option>
                    <option value="Level 3 Driver/Credentials">Level 3 Driver/ELD</option>
                    <option value="Level 4 Special Check">Level 4 Special</option>
                    <option value="Level 5 Vehicle-only">Level 5 Vehicle-only</option>
                  </select>
                </div>

                <div>
                  <label className="block text-slate-400 mb-1 font-semibold">Reporter Name</label>
                  <input 
                    type="text" 
                    value={newPinForm.reportedBy}
                    onChange={(e) => setNewPinForm({...newPinForm, reportedBy: e.target.value})}
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2 text-slate-200 outline-none focus:border-pink-500"
                  />
                </div>
              </div>

              <div>
                <label className="block text-slate-400 mb-1 font-semibold">Remarks & Visible Equipment</label>
                <textarea 
                  rows="2"
                  placeholder="Describe active patrol cars, portable scales, or trucks pulled over..."
                  value={newPinForm.notes}
                  onChange={(e) => setNewPinForm({...newPinForm, notes: e.target.value})}
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2 text-slate-200 outline-none focus:border-pink-500"
                />
              </div>

              <div className="flex justify-end gap-2 border-t border-slate-800 pt-3">
                <button 
                  type="button" 
                  onClick={() => setIsModalOpen(false)}
                  className="px-3 py-1.5 bg-slate-800 text-slate-300 rounded-lg"
                >
                  Cancel
                </button>
                <button 
                  type="submit" 
                  className="px-4 py-1.5 bg-pink-600 hover:bg-pink-500 text-white font-bold rounded-lg shadow"
                >
                  Save Observation Pin
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Footer */}
      <footer className="border-t border-slate-800 bg-slate-900/60 p-3 text-center text-xs text-slate-500 mt-auto">
        Colorado Department of Transportation & Colorado State Patrol Motor Carrier Safety Division • Mobile & Crowdsourced Inspection Portal
      </footer>
    </div>
  );
}