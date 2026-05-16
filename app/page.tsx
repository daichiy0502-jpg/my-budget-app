"use client";
import React, { useState, useEffect } from 'react';
import { GoogleGenerativeAI } from "@google/generative-ai";
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
const supabase = createClient(supabaseUrl, supabaseAnonKey);

interface ShoppingItem { id: string; name: string; checked: boolean; fridgeIn: boolean; }
interface ShoppingSection { title: string; items: ShoppingItem[]; }
interface MenuDay { day: string; content: string; }
interface HistoryItem { id: string; name: string; price: number; date: string; category: CategoryType; rawAiResponse?: string; }

type ActiveTabType = 'menu' | 'shopping' | 'stats';
type CookingModeType = '通常' | '時短' | '贅沢';
type CategoryType = '自炊' | '外食' | '買い食い' | '弁当' | 'その他';

const DAYS_OF_WEEK = ['月', '火', '水', '木', '金', '土', '日'];
const DAY_MAP_ENG_TO_JA: Record<number, string> = { 0: '日', 1: '月', 2: '火', 3: '水', 4: '木', 5: '金', 6: '土' };

export default function BudgetBiteAI() {
  // 💰 予算・ステータス
  const [baseBudget, setBaseBudget] = useState<number>(25000);
  const [isEditingBaseBudget, setIsEditingBaseBudget] = useState(false);
  const [inputBaseBudget, setInputBaseBudget] = useState("");
  const [budget, setBudget] = useState(25000);

  // 📝 入力フォーム
  const [itemName, setItemName] = useState("");
  const [expense, setExpense] = useState("");
  const [activeCategory, setActiveCategory] = useState<CategoryType>('自炊');
  const [stock, setStock] = useState(""); 
  const [userRequest, setUserRequest] = useState("平日の夜に時間がなくてもパパッと作れる時短レシピにして！");
  
  // 📅 カレンダー制御
  const [selectedDays, setSelectedDays] = useState<string[]>(['月', '火', '水', '木', '金']);
  const [dayModes, setDayModes] = useState<Record<string, CookingModeType>>({
    '月': '通常', '火': '通常', '水': '通常', '木': '通常', '金': '通常', '土': '通常', '日': '通常'
  });
  const [activeCalendarDay, setActiveCalendarDay] = useState<string>('月');

  // 🤖 AI・表示データ
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [aiResponse, setAiResponse] = useState("");
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<ActiveTabType>('menu');
  const [shoppingSections, setShoppingSections] = useState<ShoppingSection[]>([]);
  const [menuDays, setMenuDays] = useState<MenuDay[]>([]);
  
  // 🔧 編集用
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingPrice, setEditingPrice] = useState<string>("");

  useEffect(() => {
    const savedBase = localStorage.getItem('budgetbite_base_budget');
    if (savedBase) {
      const parsed = parseInt(savedBase);
      if (!isNaN(parsed)) setBaseBudget(parsed);
    }
    const currentDayIndex = new Date().getDay();
    setActiveCalendarDay(DAY_MAP_ENG_TO_JA[currentDayIndex]);
    fetchBudgetData();
  }, []);

  useEffect(() => { 
    fetchBudgetData(); 
  }, [baseBudget]);

  // AI応答テキストをパースするロジックの修正
  useEffect(() => {
    if (!aiResponse) { setShoppingSections([]); setMenuDays([]); return; }
    try {
      const menuPart = aiResponse.split(/##\s*🛒\s*買い物リスト/i)[0];
      const menuLines = menuPart.split('\n');
      const parsedDays: MenuDay[] = [];
      let currentDayName = "";
      let currentDayText: string[] = [];
      
      const dayPatterns = [
        { name: "月", regex: /(月曜日|【月】|■月|###\s*月)/ },
        { name: "火", regex: /(火曜日|【火】|■火|###\s*火)/ },
        { name: "水", regex: /(水曜日|【水】|■水|###\s*水)/ },
        { name: "木", regex: /(木曜日|【木】|■木|###\s*木)/ },
        { name: "金", regex: /(金曜日|【金】|■金|###\s*金)/ },
        { name: "土", regex: /(土曜日|【土】|■土|###\s*土)/ },
        { name: "日", regex: /(日曜日|【日】|■日|###\s*日)/ },
      ];

      menuLines.forEach((line) => {
        const foundDay = dayPatterns.find(p => p.regex.test(line.trim()));
        if (foundDay) {
          if (currentDayName && currentDayText.length > 0) {
            parsedDays.push({ day: currentDayName, content: currentDayText.join('\n').trim() });
          }
          currentDayName = foundDay.name; 
          currentDayText = [line]; 
        } else if (currentDayName) { 
          currentDayText.push(line); 
        }
      });
      if (currentDayName && currentDayText.length > 0) {
        parsedDays.push({ day: currentDayName, content: currentDayText.join('\n').trim() });
      }
      setMenuDays(parsedDays);

      const parts = aiResponse.split(/##\s*🛒\s*買い物リスト/i);
      if (parts.length < 2) { setShoppingSections([]); return; }
      
      const lines = parts[1].split('\n');
      const parsedSections: ShoppingSection[] = [];
      let currentSectionIdx = -1;

      for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
        const trimmed = lines[lineIdx].trim();
        if (!trimmed) continue;
        if (trimmed.includes('【') && trimmed.includes('】')) {
          const cleanTitle = trimmed.replace(/###|##|#|\*\*|・|\-|【|】/g, '').trim();
          parsedSections.push({ title: `【${cleanTitle}】`, items: [] });
          currentSectionIdx = parsedSections.length - 1;
        } else if (currentSectionIdx >= 0 && /^[\s\-\*・\d\.]/.test(trimmed)) {
          let name = trimmed.replace(/^[\s\-\*・\d\.]+/, '').replace(/\*\*/g, '').trim();
          if (name.length > 0 && name.length < 20) {
            parsedSections[currentSectionIdx].items.push({ id: `item-${currentSectionIdx}-${lineIdx}`, name, checked: false, fridgeIn: false });
          }
        }
      }
      setShoppingSections(parsedSections);
    } catch (e) { console.error(e); }
  }, [aiResponse]);

  const fetchBudgetData = async () => {
    try {
      const { data } = await supabase.from('budgets').select('*').order('created_at', { ascending: false });
      if (data) {
        const totalExpense = data.reduce((sum, item) => sum + (item.expense_price || 0), 0);
        const currentSavedBase = localStorage.getItem('budgetbite_base_budget');
        const activeBase = currentSavedBase ? parseInt(currentSavedBase) : baseBudget;
        setBudget(activeBase - totalExpense);

        setHistory(data.map((item): HistoryItem => {
          const nameStr = item.item_name || "記録";
          let detectedCategory: CategoryType = '自炊';
          if (nameStr.includes('[外食]')) detectedCategory = '外食';
          else if (nameStr.includes('[買い食い]')) detectedCategory = '買い食い';
          else if (nameStr.includes('[弁当]')) detectedCategory = '弁当';
          else if (nameStr.includes('[その他]')) detectedCategory = 'その他';

          return {
            id: item.id, 
            name: nameStr, 
            price: item.expense_price || 0,
            category: detectedCategory,
            rawAiResponse: item.ai_response || undefined,
            date: new Date(item.created_at).toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric' })
          };
        }));
        const lastAi = data.find(item => item.ai_response);
        if (lastAi && !aiResponse) { setAiResponse(lastAi.ai_response); setStock(lastAi.stock_items || ""); setUserRequest(lastAi.user_request || userRequest); }
      }
    } catch (e) { console.error(e); }
  };

  const addExpense = async (e: React.FormEvent) => {
    e.preventDefault(); 
    const price = parseInt(expense); 
    const finalName = `[${activeCategory}] ${itemName || "買い物"}`;
    if (isNaN(price) || price <= 0) return alert("金額を正しく入力してね");
    
    const { error } = await supabase.from('budgets').insert([{ 
      budget_amount: budget - price, 
      item_name: finalName, 
      expense_price: price, 
      stock_items: stock, 
      user_request: userRequest, 
      ai_response: aiResponse 
    }]);
    
    if (!error) { setExpense(""); setItemName(""); fetchBudgetData(); }
  };

  const deleteExpense = async (id: string) => { 
    if (confirm("削除する？")) { 
      await supabase.from('budgets').delete().eq('id', id); 
      fetchBudgetData(); 
    } 
  };

  const saveBaseBudget = () => {
    const parsed = parseInt(inputBaseBudget);
    if (isNaN(parsed) || parsed < 0) return alert("正しい予算額を入力してね！");
    setBaseBudget(parsed);
    localStorage.setItem('budgetbite_base_budget', parsed.toString());
    setIsEditingBaseBudget(false);
  };

  const toggleBasket = (sIdx: number, iIdx: number) => {
    const updated = [...shoppingSections];
    updated[sIdx].items[iIdx].checked = !updated[sIdx].items[iIdx].checked;
    setShoppingSections(updated);
  };

  const syncToFridge = (sIdx: number, iIdx: number) => {
    const updated = [...shoppingSections];
    const item = updated[sIdx].items[iIdx];
    item.fridgeIn = !item.fridgeIn;
    
    if (item.fridgeIn) {
      setStock(prev => {
        const names = prev.split(/,\s*/).filter(n => n.trim() !== "");
        if (!names.includes(item.name)) names.push(item.name);
        return names.join(', ');
      });
    } else {
      setStock(prev => prev.split(/,\s*/).filter(n => n.trim() !== item.name).join(', '));
    }
    setShoppingSections(updated);
  };

  const getStats = () => {
    const categories: CategoryType[] = ['自炊', '外食', '買い食い', '弁当', 'その他'];
    return categories.map(cat => {
      const sum = history.filter(h => h.name.includes(`[${cat}]`)).reduce((a, b) => a + b.price, 0);
      return { category: cat, total: sum };
    });
  };

  const resetData = async () => {
    if (!confirm("データをフルリセットする？")) return;
    const { error } = await supabase.from('budgets').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    if (!error) { setAiResponse(""); setHistory([]); setStock(""); fetchBudgetData(); }
  };

  const toggleDay = (day: string) => {
    if (selectedDays.includes(day)) {
      if (selectedDays.length === 1) return alert("最低でも1日は選んでね");
      setSelectedDays(selectedDays.filter(d => d !== day));
    } else {
      setSelectedDays([...selectedDays, day]);
    }
  };

  const handleModeChange = (day: string, mode: CookingModeType) => {
    setDayModes(prev => ({ ...prev, [day]: mode }));
  };

  const askGemini = async () => {
    if (selectedDays.length === 0) return alert("曜日をどれか選んでね");
    setLoading(true);
    try {
      const genAI = new GoogleGenerativeAI(process.env.NEXT_PUBLIC_GEMINI_API_KEY || "");
      const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
      const dayDirectives = selectedDays.map(d => `・${d}曜日：${dayModes[d] === '時短' ? "10分以内超時短" : dayModes[d] === '贅沢' ? "満足感のある贅沢" : "通常"}メニュー`).join('\n');
      const formatDaysPrompt = selectedDays.map(d => `### ${d}曜日\n**メニュー名**\n・手順をここに書く`).join('\n\n');
      
      const prompt = `あなたは節約料理のプロです。挨拶や雑談は一切せず、指定のフォーマットで出力してください。\n【条件】作成曜日：${selectedDays.join(', ')}\n${dayDirectives}\n余り物：${stock}\nリクエスト：${userRequest}\n\n【出力フォーマット】\n${formatDaysPrompt}\n\n## 🛒 買い物リスト\n### 【肉・魚類】\n- 食材名\n### 【野菜・その他】\n- 食材名\n### 【調味料】\n- 調味料名（省略禁止）`;
      
      const result = await model.generateContent(prompt);
      const text = result.response.text();
      setAiResponse(text); 
      setActiveTab('menu');
      await supabase.from('budgets').insert([{ budget_amount: budget, item_name: "AI相談", expense_price: 0, stock_items: stock, user_request: userRequest, ai_response: text }]);
    } catch (err: any) { alert(err.message); }
    setLoading(false);
  };

  const formatMenuContent = (rawText: string) => {
    return rawText.split('\n').filter(l => !l.trim().startsWith('###')).map((line, idx) => {
      const trimmed = line.trim(); if (!trimmed) return <div key={idx} className="h-2"></div>;
      if (trimmed.startsWith('**') && trimmed.endsWith('**')) {
        return <div key={idx} className="text-sm font-bold text-cyan-300 mt-3 mb-1 border-l-2 border-cyan-500 pl-2">🍳 {trimmed.replace(/\*\*/g, '')}</div>;
      }
      if (trimmed.startsWith('・') || trimmed.startsWith('-') || /^\d/.test(trimmed)) {
        return <div key={idx} className="text-xs text-gray-300 pl-4 py-0.5 bg-zinc-900/40 rounded my-0.5">{trimmed.replace(/^[\s・\-\d\.]+\s*/, '👉 ')}</div>;
      }
      return <div key={idx} className="text-xs text-gray-400 pl-2">{trimmed}</div>;
    });
  };

  const renderCalendar = () => {
    const days = [];
    const now = new Date();
    // 前後3日ずつの簡易カレンダーを生成
    for (let i = -3; i <= 3; i++) {
      const d = new Date(); 
      d.setDate(now.getDate() + i);
      const jaDay = DAY_MAP_ENG_TO_JA[d.getDay()];
      days.push({ date: d.getDate(), dayJa: jaDay, full: d.toDateString() });
    }
    return (
      <div className="flex justify-between gap-1 bg-zinc-950 p-2 rounded-2xl border border-zinc-900 mb-4 overflow-x-auto">
        {days.map(d => (
          <button key={d.full} type="button" onClick={() => setActiveCalendarDay(d.dayJa)} className={`flex-1 flex flex-col items-center py-2 px-1 rounded-xl transition-all ${activeCalendarDay === d.dayJa ? 'bg-cyan-600 text-white shadow-lg' : 'text-gray-500 hover:bg-zinc-900'}`}>
            <span className="text-[9px] font-bold opacity-70">{d.dayJa}</span>
            <span className="text-sm font-mono font-bold">{d.date}</span>
            {selectedDays.includes(d.dayJa) && <div className="w-1 h-1 bg-cyan-300 rounded-full mt-1"></div>}
          </button>
        ))}
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-black text-gray-200 p-6 font-sans pb-20">
      <header className="max-w-md mx-auto mb-8 text-center">
        <h1 className="text-4xl font-bold text-cyan-400 italic">BudgetBite <span className="text-xs bg-cyan-900 px-2 py-0.5 rounded-full">v3.0</span></h1>
      </header>

      <main className="max-w-md mx-auto space-y-6">
        {/* 💳 予算カード */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-[2.5rem] p-8 text-center shadow-2xl">
          <p className="text-xs uppercase tracking-widest text-gray-500 mb-1">Remaining Budget</p>
          <div className="text-5xl font-mono text-white mb-2 font-bold">¥{budget.toLocaleString()}</div>
          <div className="text-[10px] text-cyan-600 font-bold">
            {isEditingBaseBudget ? (
               <div className="flex justify-center items-center gap-1">
                 <input type="number" value={inputBaseBudget} onChange={(e)=>setInputBaseBudget(e.target.value)} className="bg-black text-white w-20 text-center border border-zinc-700 rounded py-0.5 text-xs"/>
                 <button type="button" onClick={saveBaseBudget} className="text-green-400 font-bold px-1">[OK]</button>
                 <button type="button" onClick={()=>setIsEditingBaseBudget(false)} className="text-gray-500 px-1">✕</button>
               </div>
            ) : (
               <span onClick={() => { setIsEditingBaseBudget(true); setInputBaseBudget(baseBudget.toString()); }}>基準予算: ¥{baseBudget.toLocaleString()} ✏️</span>
            )}
          </div>
        </div>

        {/* 💰 カテゴリー付き出費入力 */}
        <div className="bg-zinc-900/40 p-4 rounded-3xl border border-zinc-800 space-y-3">
          <div className="flex gap-1 bg-black p-1 rounded-xl border border-zinc-900">
            {(['自炊', '外食', '買い食い', '弁当'] as CategoryType[]).map(cat => (
              <button key={cat} type="button" onClick={() => setActiveCategory(cat)} className={`flex-1 py-1.5 rounded-lg text-[10px] font-bold transition-all ${activeCategory === cat ? 'bg-zinc-800 text-white border border-zinc-700' : 'text-gray-600'}`}>{cat}</button>
            ))}
          </div>
          <form onSubmit={addExpense} className="flex gap-2">
            <input type="text" value={itemName} onChange={(e)=>setItemName(e.target.value)} placeholder="品名(任意)" className="flex-1 bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-2 text-white text-xs focus:outline-none"/>
            <input type="number" value={expense} onChange={(e)=>setExpense(e.target.value)} placeholder="金額" className="w-24 bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-2 text-white font-mono text-lg focus:outline-none"/>
            <button type="submit" className="bg-white text-black px-4 rounded-xl font-bold text-xs">記録</button>
          </form>
        </div>

        {/* 📅 週間カレンダー表示 */}
        {renderCalendar()}

        {/* 🛠️ AIプランニング & 在庫管理 */}
        <div className="bg-zinc-900/40 p-4 rounded-3xl border border-zinc-800 space-y-4">
          <div className="space-y-2">
            <label className="text-[10px] font-bold text-gray-500 uppercase tracking-widest pl-1">Daily Mode Settings</label>
            <div className="grid grid-cols-4 gap-1">
              {DAYS_OF_WEEK.map(day => (
                <button key={day} type="button" onClick={() => toggleDay(day)} className={`py-2 rounded-xl text-[10px] font-bold border transition-all ${selectedDays.includes(day) ? 'bg-cyan-900/30 border-cyan-700 text-cyan-300' : 'bg-transparent border-zinc-800 text-zinc-700'}`}>{day}</button>
              ))}
            </div>
            {selectedDays.includes(activeCalendarDay) && (
              <div className="flex gap-1 bg-black p-1 rounded-xl border border-zinc-900">
                {(['通常', '時短', '贅沢'] as CookingModeType[]).map(m => (
                  <button key={m} type="button" onClick={() => handleModeChange(activeCalendarDay, m)} className={`flex-1 py-1.5 rounded-lg text-[10px] font-bold ${dayModes[activeCalendarDay] === m ? 'bg-zinc-800 text-white' : 'text-gray-600'}`}>{m}</button>
                ))}
              </div>
            )}
          </div>
          <input type="text" value={stock} onChange={(e)=>setStock(e.target.value)} placeholder="在庫リスト（冷蔵庫に入れると自動追記）" className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-3 text-white text-xs focus:outline-none"/>
          <button type="button" onClick={askGemini} disabled={loading} className="w-full py-5 bg-gradient-to-r from-cyan-600 to-blue-600 text-white rounded-2xl font-bold shadow-xl disabled:opacity-50">{loading ? "Gemini思考中..." : "AIコンシェルジュに相談する"}</button>
        </div>

        {/* 🍽️ AI応答エリア */}
        {aiResponse && (
          <div className="bg-zinc-900 border border-zinc-800 rounded-3xl p-5 shadow-2xl">
            <div className="flex gap-1 mb-4 bg-zinc-950 p-1 rounded-xl border border-zinc-800">
              <button type="button" onClick={() => setActiveTab('menu')} className={`flex-1 py-2 rounded-lg font-bold text-[10px] ${activeTab === 'menu' ? 'bg-cyan-600 text-white' : 'text-gray-500'}`}>📅 献立</button>
              <button type="button" onClick={() => setActiveTab('shopping')} className={`flex-1 py-2 rounded-lg font-bold text-[10px] ${activeTab === 'shopping' ? 'bg-cyan-600 text-white' : 'text-gray-500'}`}>🛒 リスト</button>
              <button type="button" onClick={() => setActiveTab('stats')} className={`flex-1 py-2 rounded-lg font-bold text-[10px] ${activeTab === 'stats' ? 'bg-cyan-600 text-white' : 'text-gray-500'}`}>📊 分析</button>
            </div>
            
            <div className="text-gray-300 text-sm max-h-[400px] overflow-y-auto">
              {activeTab === 'menu' && (
                <div className="bg-zinc-950 p-4 rounded-2xl border border-zinc-800">
                  <div className="text-cyan-400 font-bold mb-2 border-b border-cyan-900 pb-1 flex justify-between items-center">
                    <span>{activeCalendarDay}曜日のレシピ</span>
                    <span className="text-[10px] bg-zinc-900 px-2 rounded-full">{dayModes[activeCalendarDay] || '通常'}モード</span>
                  </div>
                  {formatMenuContent(menuDays.find(d => d.day === activeCalendarDay)?.content || "計画がありません")}
                </div>
              )}

              {activeTab === 'shopping' && (
                <div className="space-y-4">
                  {shoppingSections.map((sec, sIdx) => (
                    <div key={sIdx} className="border-b border-zinc-800 pb-3 last:border-0">
                      <h4 className="text-[10px] font-bold text-cyan-500 mb-2 uppercase tracking-widest">{sec.title}</h4>
                      <div className="grid grid-cols-1 gap-2">
                        {sec.items.map((item, iIdx) => (
                          <div key={item.id} className="flex gap-2">
                            <button type="button" onClick={() => toggleBasket(sIdx, iIdx)} className={`flex-1 border rounded-xl px-3 py-2 text-left flex items-center gap-2 transition-all ${item.checked ? 'text-gray-600 bg-zinc-900/20 border-zinc-800 line-through' : 'text-gray-300 bg-zinc-950 border-zinc-800/40'}`}>
                              <div className={`w-3.5 h-3.5 rounded border flex items-center justify-center ${item.checked ? 'bg-cyan-900 border-cyan-600' : 'border-zinc-700'}`}>{item.checked && "✓"}</div>
                              <span className="text-xs truncate">{item.name}</span>
                            </button>
                            <button type="button" onClick={() => syncToFridge(sIdx, iIdx)} className={`px-3 py-2 rounded-xl border text-[10px] font-bold transition-all ${item.fridgeIn ? 'bg-green-900/30 text-green-400 border-green-800' : 'bg-zinc-950 text-gray-700 border-zinc-800'}`}>冷蔵庫</button>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {activeTab === 'stats' && (
                <div className="space-y-4 p-2">
                  <p className="text-xs font-bold text-gray-500 mb-4">CATEGORY BREAKDOWN</p>
                  {getStats().map(s => (
                    <div key={s.category} className="space-y-1">
                      <div className="flex justify-between text-[10px] font-bold uppercase">
                        <span className={s.category === '外食' || s.category === '買い食い' ? 'text-red-400' : 'text-cyan-400'}>{s.category}</span>
                        <span className="font-mono">¥{s.total.toLocaleString()}</span>
                      </div>
                      <div className="w-full bg-zinc-900 h-2 rounded-full overflow-hidden border border-zinc-800">
                        <div className={`h-full transition-all ${s.category === '外食' ? 'bg-red-500' : s.category === '買い食い' ? 'bg-orange-500' : 'bg-green-500'}`} style={{ width: `${Math.min(100, (s.total / 10000) * 100)}%` }}></div>
                      </div>
                    </div>
                  ))}
                  <p className="text-[9px] text-gray-600 italic mt-6">*自炊と弁当の比率を高めて、規律ある食生活を目指しましょう！</p>
                </div>
              )}
            </div>
          </div>
        )}

        <div className="bg-zinc-900/30 rounded-2xl p-4 border border-zinc-800 space-y-3">
          <p className="text-[10px] font-bold text-gray-500 uppercase tracking-widest px-1">Recent Activity</p>
          {history.slice(0, 5).map(item => (
            <div key={item.id} className="flex justify-between items-center text-xs pb-1 border-b border-zinc-900 last:border-0">
               <span className="text-gray-400">{item.name}</span>
               <div className="flex gap-2 items-center">
                 <span className={item.price > 0 ? "text-red-400 font-mono" : "text-cyan-400 font-bold"}>{item.price > 0 ? `-¥${item.price.toLocaleString()}` : "AI"}</span>
                 <button type="button" onClick={() => deleteExpense(item.id)} className="text-[10px] opacity-40">🗑️</button>
               </div>
            </div>
          ))}
        </div>

        <div className="text-center pt-8"><button type="button" onClick={resetData} className="text-zinc-800 text-[9px] uppercase tracking-widest font-bold">Factory Reset</button></div>
      </main>
    </div>
  );
}