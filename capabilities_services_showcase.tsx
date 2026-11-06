import React, { useState, useMemo } from 'react';
import { 
  Layers, 
  Cpu, 
  MapPin, 
  TrendingUp, 
  Code2, 
  Calculator, 
  Calendar, 
  CheckCircle2, 
  ChevronRight, 
  Terminal, 
  ShieldCheck, 
  Zap, 
  ArrowRight, 
  Copy, 
  Check, 
  Filter,
  Sparkles,
  Server,
  Globe,
  DollarSign
} from 'lucide-react';

// Code snippets for technical buyers preview
const CODE_SNIPPETS = {
  aiPipeline: {
    title: "Context Injection Middleware",
    lang: "typescript",
    filename: "ai/pipeline/contextInjector.ts",
    code: `import { OpenAI } from 'openai';
import { HeliconeLogger } from '@helicone/async';

export interface ContextPayload {
  tenantId: string;
  userRole: 'ADMIN' | 'INSPECTOR' | 'OPERATOR';
  geospatialBounds?: [number, number, number, number];
  activeTier: 'STARTER' | 'PROFESSIONAL' | 'ENTERPRISE';
}

export async function executeContextRouting(prompt: string, context: ContextPayload) {
  // Model Tier Routing Strategy to balance performance & latency
  const model = context.activeTier === 'ENTERPRISE' ? 'gpt-4o' : 'gpt-4o-mini';
  
  const systemContext = \`
  [SYSTEM CONTEXT INJECTION]
  Tenant ID: \${context.tenantId}
  Role: \${context.userRole}
  Active Boundary Filter: \${JSON.stringify(context.geospatialBounds || 'GLOBAL')}
  Rule: Output strictly structured JSON compliance logs with zero hallucination.
  \`;

  const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    defaultHeaders: {
      "Helicone-Auth": \`Bearer \${process.env.HELICONE_API_KEY}\`,
      "Helicone-Property-TenantId": context.tenantId
    }
  });

  return await openai.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: systemContext },
      { role: 'user', content: prompt }
    ],
    temperature: 0.2
  });
}`
  },
  multiTenant: {
    title: "Multi-Tenant RLS Router",
    lang: "typescript",
    filename: "db/tenantResolver.ts",
    code: `import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export async function withTenantContext<T>(
  tenantId: string, 
  callback: (tx: any) => Promise<T>
): Promise<T> {
  return await prisma.$transaction(async (tx) => {
    // Enforce PostgreSQL Row Level Security context session key
    await tx.$executeRawUnsafe(
      \`SET LOCAL app.current_tenant_id = '\${tenantId}';\`
    );
    
    // Execute isolated query inside tenant boundary
    return await callback(tx);
  });
}`
  },
  gisEngine: {
    title: "Spatial Geofence Aggregator",
    lang: "typescript",
    filename: "gis/spatialCluster.ts",
    code: `import * as turf from '@turf/turf';

export function aggregateInspectionHotspots(points: Array<[number, number]>, radiusKm: number) {
  const collection = turf.featureCollection(
    points.map(p => turf.point(p))
  );

  const clustered = turf.clustersDbscan(collection, radiusKm, { minPoints: 3 });
  
  return clustered.features.map(f => ({
    coords: f.geometry.coordinates,
    clusterId: f.properties?.cluster,
    isNoise: f.properties?.dbscan === 'noise'
  }));
}`
  }
};

// Capabilities Data
const CAPABILITIES = [
  {
    id: "saas-arch",
    category: "Architecture",
    title: "SaaS Platform Architecture & Multi-Tenant Engineering",
    icon: Server,
    description: "Battle-tested multi-tenant cloud architectures built for scalability, strict tenant isolation, and resilient high-throughput infrastructure.",
    badge: "Scale Architecture",
    tags: ["Next.js 14", "PostgreSQL RLS", "Supabase", "Redis Cache", "Tenant Isolation"],
    tiers: ["growth", "enterprise"],
    highlights: [
      "Row-Level Security (RLS) dynamic tenant context resolution",
      "Sub-100ms API response rates using Redis edge caching",
      "Zero-downtime database migrations & schema isolation",
      "Enterprise SOC2-compliant access control architecture"
    ],
    codeKey: "multiTenant"
  },
  {
    id: "ai-context",
    category: "Artificial Intelligence",
    title: "AI & Context Injection Pipelines",
    icon: Cpu,
    description: "Production LLM middleware featuring intelligent context caching, model tier routing, zero-hallucination prompts, and Helicone observability.",
    badge: "AI Infrastructure",
    tags: ["LangChain", "Helicone AI", "Model Routing", "RAG Systems", "Vector Embeddings"],
    tiers: ["mvp", "growth", "enterprise"],
    highlights: [
      "Dynamic model tier routing cutting inference costs by up to 65%",
      "Structured JSON context payload injection and strict schemas",
      "Real-time token cost, latency, and cache hit rate tracking",
      "Automated fallback & retry policies for mission-critical prompts"
    ],
    codeKey: "aiPipeline"
  },
  {
    id: "gis-spatial",
    category: "Location Intelligence",
    title: "Real-Time GIS & Spatial Intelligence",
    icon: MapPin,
    description: "High-performance geospatial visualization engines for field operations, dynamic route tracking, polygon geofencing, and inspection analytics.",
    badge: "Geospatial Ops",
    tags: ["Mapbox GL", "Leaflet", "Turf.js", "PostGIS", "GeoJSON Pipelines"],
    tiers: ["growth", "enterprise"],
    highlights: [
      "DBSCAN spatial clustering for real-time asset density mapping",
      "Offline-first mobile GIS coordinate sync pipelines",
      "Custom interactive vector maps with dynamic layers",
      "Multi-state transit boundary validation & automated alerts"
    ],
    codeKey: "gisEngine"
  },
  {
    id: "fin-modeling",
    category: "Financial Strategy",
    title: "Unit Economics & Financial Strategy Modeling",
    icon: TrendingUp,
    description: "Multi-scenario financial modeling and automated Stripe billing integrations structured to maximize LTV:CAC ratios and investor predictability.",
    badge: "Growth Economics",
    tags: ["Stripe Metered Billing", "LTV:CAC Forecasting", "Retention Analytics", "Cohort Dynamics"],
    tiers: ["mvp", "growth"],
    highlights: [
      "Automated seat-based & usage-metered billing integration",
      "Dynamic LTV:CAC scenario calculators with churn modeling",
      "Investor-grade financial dashboards & metrics tracking",
      "Margin optimization across API inference & cloud spend"
    ],
    codeKey: "aiPipeline"
  }
];

export default function CapabilitiesShowcase() {
  // State management
  const [selectedScope, setSelectedScope] = useState('all');
  const [activeCodeKey, setActiveCodeKey] = useState('aiPipeline');
  const [copied, setCopied] = useState(false);
  
  // Interactive Calculator State
  const [teamSize, setTeamSize] = useState(25);
  const [complexity, setComplexity] = useState('medium'); // 'low', 'medium', 'high'
  const [hasAI, setHasAI] = useState(true);
  const [hasGIS, setHasGIS] = useState(true);

  // Consultation Modal / Form State
  const [selectedCapabilities, setSelectedCapabilities] = useState(['ai-context']);
  const [showConsultationModal, setShowConsultationModal] = useState(false);
  const [consultationStep, setConsultationStep] = useState(1);
  const [contactEmail, setContactEmail] = useState('');
  const [isSubmitted, setIsSubmitted] = useState(false);

  // Filter capabilities based on tier
  const filteredCapabilities = useMemo(() => {
    if (selectedScope === 'all') return CAPABILITIES;
    return CAPABILITIES.filter(cap => cap.tiers.includes(selectedScope));
  }, [selectedScope]);

  // Dynamic ROI calculation algorithm
  const estimatedImpact = useMemo(() => {
    let baseDevCost = teamSize * 1800;
    let complexityMultiplier = complexity === 'low' ? 0.8 : complexity === 'medium' ? 1.2 : 1.8;
    
    let totalEngineeringCost = baseDevCost * complexityMultiplier;
    if (hasAI) totalEngineeringCost += 8000;
    if (hasGIS) totalEngineeringCost += 6000;

    let timeToMarketDays = Math.round((totalEngineeringCost / 500) * (complexity === 'high' ? 0.85 : 0.7));
    let projectedSavings = Math.round(totalEngineeringCost * 0.42);
    let ltvMultiplier = (hasAI ? 1.4 : 1.0) * (hasGIS ? 1.3 : 1.0) * (complexity === 'high' ? 1.5 : 1.2);

    return {
      totalEngineeringCost,
      timeToMarketDays,
      projectedSavings,
      ltvMultiplier: ltvMultiplier.toFixed(1)
    };
  }, [teamSize, complexity, hasAI, hasGIS]);

  // Copy code handler
  const handleCopyCode = (text) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const toggleCapabilitySelection = (id) => {
    setSelectedCapabilities(prev => 
      prev.includes(id) ? prev.filter(item => item !== id) : [...prev, id]
    );
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 font-sans antialiased selection:bg-sky-500 selection:text-white">
      
      {/* Background Subtle Frost & Glow Gradients */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden z-0">
        <div className="absolute -top-40 -left-40 w-96 h-96 bg-sky-500/10 rounded-full blur-3xl"></div>
        <div className="absolute top-1/3 -right-40 w-96 h-96 bg-emerald-500/10 rounded-full blur-3xl"></div>
        <div className="absolute bottom-10 left-1/3 w-96 h-96 bg-blue-600/10 rounded-full blur-3xl"></div>
      </div>

      <div className="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
        
        {/* Header Section */}
        <div className="text-center max-w-3xl mx-auto mb-16">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-slate-900/80 border border-sky-500/30 backdrop-blur-md mb-6">
            <Sparkles className="w-4 h-4 text-sky-400" />
            <span className="text-xs font-semibold tracking-wider text-sky-300 uppercase">
              SnowSeasons Tech Engineering
            </span>
          </div>
          <h1 className="text-4xl sm:text-5xl font-extrabold tracking-tight bg-clip-text text-transparent bg-gradient-to-r from-white via-sky-100 to-sky-400 mb-6">
            Capabilities & Systems Architecture
          </h1>
          <p className="text-lg text-slate-400 leading-relaxed">
            We architect and deploy production-ready cloud platforms, context-injected AI pipelines, real-time spatial analytics, and financial engines that power modern software enterprises.
          </p>
        </div>

        {/* Filter Bar */}
        <div className="flex flex-col sm:flex-row items-center justify-between gap-4 mb-10 p-2 bg-slate-900/60 border border-slate-800 rounded-2xl backdrop-blur-md">
          <div className="flex items-center gap-2 px-3 py-1 text-xs font-semibold text-slate-400 uppercase tracking-wider">
            <Filter className="w-4 h-4 text-sky-400" />
            <span>Filter by Target Scope:</span>
          </div>
          <div className="flex items-center gap-2 w-full sm:w-auto overflow-x-auto pb-1 sm:pb-0">
            {[
              { id: 'all', label: 'All Capabilities' },
              { id: 'mvp', label: 'MVP / Quickstart' },
              { id: 'growth', label: 'Growth Stage' },
              { id: 'enterprise', label: 'Enterprise SaaS' }
            ].map(tier => (
              <button
                key={tier.id}
                onClick={() => setSelectedScope(tier.id)}
                className={`px-4 py-2 rounded-xl text-xs font-medium transition-all whitespace-nowrap ${
                  selectedScope === tier.id
                    ? 'bg-sky-500 text-slate-950 font-semibold shadow-lg shadow-sky-500/20'
                    : 'text-slate-400 hover:text-white hover:bg-slate-800/60'
                }`}
              >
                {tier.label}
              </button>
            ))}
          </div>
        </div>

        {/* Capabilities Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mb-20">
          {filteredCapabilities.map((cap) => {
            const Icon = cap.icon;
            const isCodeActive = activeCodeKey === cap.codeKey;

            return (
              <div 
                key={cap.id}
                className="group relative bg-slate-900/50 border border-slate-800 hover:border-sky-500/40 rounded-3xl p-8 backdrop-blur-xl transition-all duration-300 hover:shadow-2xl hover:shadow-sky-500/10 flex flex-col justify-between"
              >
                <div>
                  <div className="flex items-center justify-between mb-6">
                    <div className="p-3 bg-sky-500/10 border border-sky-500/20 rounded-2xl text-sky-400 group-hover:scale-105 transition-transform">
                      <Icon className="w-6 h-6" />
                    </div>
                    <span className="text-xs font-semibold px-3 py-1 rounded-full bg-slate-800 text-slate-300 border border-slate-700">
                      {cap.badge}
                    </span>
                  </div>

                  <h3 className="text-xl font-bold text-slate-100 mb-3 group-hover:text-sky-300 transition-colors">
                    {cap.title}
                  </h3>
                  <p className="text-sm text-slate-400 mb-6 leading-relaxed">
                    {cap.description}
                  </p>

                  <div className="space-y-2.5 mb-6">
                    {cap.highlights.map((item, idx) => (
                      <div key={idx} className="flex items-start gap-2 text-xs text-slate-300">
                        <CheckCircle2 className="w-4 h-4 text-emerald-400 mt-0.5 shrink-0" />
                        <span>{item}</span>
                      </div>
                    ))}
                  </div>
                </div>

                <div>
                  {/* Tech Tags */}
                  <div className="flex flex-wrap gap-2 mb-6">
                    {cap.tags.map((tag, idx) => (
                      <span key={idx} className="px-2.5 py-1 text-[11px] rounded-md bg-slate-950/80 text-sky-400 border border-slate-800 font-mono">
                        {tag}
                      </span>
                    ))}
                  </div>

                  {/* Actions */}
                  <div className="pt-4 border-t border-slate-800/80 flex items-center justify-between gap-4">
                    <button
                      onClick={() => setActiveCodeKey(cap.codeKey)}
                      className="inline-flex items-center gap-1.5 text-xs font-semibold text-sky-400 hover:text-sky-300 transition-colors"
                    >
                      <Code2 className="w-4 h-4" />
                      <span>View Code Architecture</span>
                    </button>

                    <button
                      onClick={() => {
                        toggleCapabilitySelection(cap.id);
                        setShowConsultationModal(true);
                      }}
                      className={`inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                        selectedCapabilities.includes(cap.id)
                          ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                          : 'bg-slate-800 hover:bg-slate-700 text-slate-200'
                      }`}
                    >
                      {selectedCapabilities.includes(cap.id) ? 'Added to Scope' : 'Add to Scope'}
                      <ChevronRight className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Code Architecture Preview Section */}
        <div className="mb-20 bg-slate-900/80 border border-slate-800 rounded-3xl overflow-hidden shadow-2xl backdrop-blur-xl">
          <div className="bg-slate-950 px-6 py-4 border-b border-slate-800 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="flex gap-1.5">
                <div className="w-3 h-3 rounded-full bg-rose-500/80"></div>
                <div className="w-3 h-3 rounded-full bg-amber-500/80"></div>
                <div className="w-3 h-3 rounded-full bg-emerald-500/80"></div>
              </div>
              <span className="text-xs font-mono text-slate-400 flex items-center gap-1.5">
                <Terminal className="w-3.5 h-3.5 text-sky-400" />
                {CODE_SNIPPETS[activeCodeKey].filename}
              </span>
            </div>

            {/* Code Selector Tabs */}
            <div className="flex items-center gap-2 overflow-x-auto w-full sm:w-auto">
              {Object.keys(CODE_SNIPPETS).map((key) => (
                <button
                  key={key}
                  onClick={() => setActiveCodeKey(key)}
                  className={`px-3 py-1 rounded-lg text-xs font-mono transition-all ${
                    activeCodeKey === key
                      ? 'bg-sky-500/20 text-sky-300 border border-sky-500/30'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {CODE_SNIPPETS[key].title}
                </button>
              ))}
              <button
                onClick={() => handleCopyCode(CODE_SNIPPETS[activeCodeKey].code)}
                className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 ml-2 transition-colors"
                title="Copy Code"
              >
                {copied ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
              </button>
            </div>
          </div>

          <div className="p-6 overflow-x-auto bg-slate-950/90 font-mono text-xs leading-relaxed text-slate-300">
            <pre>
              <code>{CODE_SNIPPETS[activeCodeKey].code}</code>
            </pre>
          </div>
        </div>

        {/* Interactive Scope & ROI Estimator */}
        <div className="mb-20 bg-gradient-to-b from-slate-900/90 to-slate-950 border border-slate-800 rounded-3xl p-8 sm:p-10 backdrop-blur-xl">
          <div className="max-w-2xl mb-8">
            <div className="inline-flex items-center gap-2 text-xs font-semibold text-emerald-400 uppercase tracking-wider mb-3">
              <Calculator className="w-4 h-4" />
              <span>Interactive ROI & Estimator</span>
            </div>
            <h2 className="text-2xl sm:text-3xl font-bold text-slate-100 mb-3">
              Estimate Engineering Impact & Savings
            </h2>
            <p className="text-sm text-slate-400">
              Configure your projected operational scale to calculate delivery acceleration and efficiency gains.
            </p>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-center">
            {/* Input Controls */}
            <div className="lg:col-span-7 space-y-6">
              {/* Slider: Team / User Scale */}
              <div>
                <div className="flex justify-between text-xs font-semibold text-slate-300 mb-2">
                  <span>Target User / Active Ops Scale:</span>
                  <span className="text-sky-400 font-mono">{teamSize} Active Units / Accounts</span>
                </div>
                <input
                  type="range"
                  min="5"
                  max="150"
                  step="5"
                  value={teamSize}
                  onChange={(e) => setTeamSize(Number(e.target.value))}
                  className="w-full h-2 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-sky-400"
                />
              </div>

              {/* Complexity Selection */}
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-2">
                  System Architecture Complexity:
                </label>
                <div className="grid grid-cols-3 gap-3">
                  {[
                    { id: 'low', label: 'Standard Web' },
                    { id: 'medium', label: 'Multi-Tenant SaaS' },
                    { id: 'high', label: 'Enterprise Complex' }
                  ].map((level) => (
                    <button
                      key={level.id}
                      onClick={() => setComplexity(level.id)}
                      className={`py-2.5 px-3 rounded-xl text-xs font-medium border transition-all ${
                        complexity === level.id
                          ? 'bg-sky-500/20 border-sky-500/50 text-sky-200'
                          : 'bg-slate-950 border-slate-800 text-slate-400 hover:border-slate-700'
                      }`}
                    >
                      {level.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Module Toggles */}
              <div className="grid grid-cols-2 gap-4 pt-2">
                <label className="flex items-center gap-3 p-3 bg-slate-950 rounded-xl border border-slate-800 cursor-pointer hover:border-slate-700">
                  <input
                    type="checkbox"
                    checked={hasAI}
                    onChange={(e) => setHasAI(e.target.checked)}
                    className="w-4 h-4 rounded accent-sky-400"
                  />
                  <span className="text-xs font-medium text-slate-300">AI / Context Pipeline</span>
                </label>

                <label className="flex items-center gap-3 p-3 bg-slate-950 rounded-xl border border-slate-800 cursor-pointer hover:border-slate-700">
                  <input
                    type="checkbox"
                    checked={hasGIS}
                    onChange={(e) => setHasGIS(e.target.checked)}
                    className="w-4 h-4 rounded accent-sky-400"
                  />
                  <span className="text-xs font-medium text-slate-300">Geospatial GIS Engine</span>
                </label>
              </div>
            </div>

            {/* Impact Calculation Display */}
            <div className="lg:col-span-5 bg-slate-950 p-6 rounded-2xl border border-slate-800 flex flex-col justify-between space-y-6">
              <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400">
                Projected System Metrics
              </h4>

              <div className="grid grid-cols-2 gap-4">
                <div className="p-4 rounded-xl bg-slate-900/60 border border-slate-800">
                  <span className="text-[11px] text-slate-400 block mb-1">Time to MVP</span>
                  <span className="text-2xl font-bold font-mono text-emerald-400">
                    ~{estimatedImpact.timeToMarketDays} Days
                  </span>
                </div>

                <div className="p-4 rounded-xl bg-slate-900/60 border border-slate-800">
                  <span className="text-[11px] text-slate-400 block mb-1">Cloud Spend Saved</span>
                  <span className="text-2xl font-bold font-mono text-sky-400">
                    ${estimatedImpact.projectedSavings.toLocaleString()}
                  </span>
                </div>
              </div>

              <div className="p-4 rounded-xl bg-sky-500/10 border border-sky-500/20 flex items-center justify-between">
                <div>
                  <span className="text-xs text-sky-300 block font-semibold">LTV Acceleration Score</span>
                  <span className="text-xs text-slate-400">Inference & retention boost</span>
                </div>
                <span className="text-2xl font-extrabold font-mono text-sky-300">
                  {estimatedImpact.ltvMultiplier}x
                </span>
              </div>

              <button
                onClick={() => setShowConsultationModal(true)}
                className="w-full py-3 rounded-xl bg-sky-500 hover:bg-sky-400 text-slate-950 font-bold text-xs tracking-wide transition-all shadow-lg shadow-sky-500/20 flex items-center justify-center gap-2"
              >
                <span>Request Custom Architecture Plan</span>
                <ArrowRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>

        {/* Call To Action Banner */}
        <div className="relative rounded-3xl p-8 sm:p-12 overflow-hidden border border-sky-500/30 bg-gradient-to-r from-sky-950/40 via-slate-900/80 to-slate-950 backdrop-blur-xl flex flex-col md:flex-row items-center justify-between gap-8">
          <div className="max-w-xl">
            <h3 className="text-2xl sm:text-3xl font-extrabold text-slate-100 mb-3">
              Ready to scale your technical capabilities?
            </h3>
            <p className="text-sm text-slate-400">
              Schedule a technical scoping consultation with our lead software architects.
            </p>
          </div>

          <button
            onClick={() => setShowConsultationModal(true)}
            className="px-6 py-4 rounded-2xl bg-sky-400 hover:bg-sky-300 text-slate-950 font-extrabold text-sm transition-all shadow-xl shadow-sky-500/20 flex items-center gap-2 shrink-0"
          >
            <Calendar className="w-4 h-4" />
            <span>Schedule Scoping Session</span>
          </button>
        </div>

      </div>

      {/* Interactive Consultation & Scope Builder Modal */}
      {showConsultationModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-md">
          <div className="bg-slate-900 border border-slate-800 rounded-3xl max-w-lg w-full p-8 relative shadow-2xl">
            <button
              onClick={() => setShowConsultationModal(false)}
              className="absolute top-6 right-6 text-slate-400 hover:text-white text-sm"
            >
              ✕
            </button>

            {!isSubmitted ? (
              <div>
                <div className="mb-6">
                  <span className="text-xs font-semibold text-sky-400 uppercase tracking-wider block mb-1">
                    Project Scope Builder
                  </span>
                  <h3 className="text-xl font-bold text-slate-100">
                    Schedule Engineering Consultation
                  </h3>
                </div>

                <div className="space-y-4 mb-6">
                  <div>
                    <label className="block text-xs font-semibold text-slate-300 mb-2">
                      Selected Capabilities ({selectedCapabilities.length}):
                    </label>
                    <div className="space-y-2">
                      {CAPABILITIES.map(cap => (
                        <div
                          key={cap.id}
                          onClick={() => toggleCapabilitySelection(cap.id)}
                          className={`p-3 rounded-xl border text-xs flex items-center justify-between cursor-pointer transition-all ${
                            selectedCapabilities.includes(cap.id)
                              ? 'bg-sky-500/10 border-sky-500/40 text-sky-300'
                              : 'bg-slate-950 border-slate-800 text-slate-400'
                          }`}
                        >
                          <span className="font-medium">{cap.title}</span>
                          {selectedCapabilities.includes(cap.id) && <Check className="w-4 h-4 text-sky-400" />}
                        </div>
                      ))}
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-slate-300 mb-1">
                      Work Email
                    </label>
                    <input
                      type="email"
                      required
                      placeholder="engineering@company.com"
                      value={contactEmail}
                      onChange={(e) => setContactEmail(e.target.value)}
                      className="w-full px-4 py-3 rounded-xl bg-slate-950 border border-slate-800 text-sm text-slate-100 focus:outline-none focus:border-sky-500"
                    />
                  </div>
                </div>

                <button
                  onClick={() => setIsSubmitted(true)}
                  disabled={!contactEmail}
                  className="w-full py-3.5 rounded-xl bg-sky-500 hover:bg-sky-400 text-slate-950 font-bold text-xs tracking-wider transition-all disabled:opacity-50"
                >
                  Submit Consultation Request
                </button>
              </div>
            ) : (
              <div className="text-center py-8">
                <div className="w-12 h-12 bg-emerald-500/20 text-emerald-400 rounded-full flex items-center justify-center mx-auto mb-4 border border-emerald-500/30">
                  <Check className="w-6 h-6" />
                </div>
                <h3 className="text-xl font-bold text-slate-100 mb-2">
                  Scoping Request Received
                </h3>
                <p className="text-xs text-slate-400 mb-6 leading-relaxed">
                  Our engineering team will review your selected modules and reach out to <span className="text-sky-300">{contactEmail}</span> within 24 hours.
                </p>
                <button
                  onClick={() => {
                    setIsSubmitted(false);
                    setShowConsultationModal(false);
                  }}
                  className="px-6 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-slate-200"
                >
                  Close Window
                </button>
              </div>
            )}
          </div>
        </div>
      )}

    </div>
  );
}