"use client";
import React, { useState, useEffect } from 'react';
import { GoogleGenerativeAI } from "@google/generative-ai";
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
const supabase = createClient(supabaseUrl, supabaseAnonKey);

interface ShoppingItem { id: string; name: string; checked: boolean; fridgeIn: boolean; }
interface ShoppingSection { title: string; items: ShoppingItem[]; }
interface HistoryItem { id: string; name: string; price: number; date: string; category: CategoryType; rawAiResponse?: string; rawNameOnly: string; }

type ActiveTabType = 'menu' | 'shopping' | 'stats';
type CategoryType = '自炊' | '外食' | '買い食い' | '会社の弁当' | 'その他';

// 🏪 動的なクイック店舗用の型
interface DynamicShop {
  label: string;
  itemName: string;
  category: CategoryType;
  defaultPrice: string;
}

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
  const [selectedYear, setSelectedYear] = useState<number>(new Date().getFullYear());
  const [selectedMonth, setSelectedMonth] = useState<number>(new Date().getMonth() + 1);
  const [selectedDay, setSelectedDay] = useState<number>(new Date().getDate());

  // 🤖 AI・表示データ
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [aiResponse, setAiResponse] = useState("");
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<ActiveTabType>('menu');
  const [shoppingSections, setShoppingSections] = useState<ShoppingSection[]>([]);
  const [archivedMenu, setArchivedMenu] = useState<string | null>(null);

  // 🏪 履歴から自動抽出された「よく行くお店」リスト
  const [dynamicShops, setDynamicShops] = useState<DynamicShop[]>([]);

  useEffect(() => {
    const savedBase = localStorage.getItem('budgetbite_base_budget');
    if (savedBase) {
      const parsed = parseInt(savedBase);
      if (!isNaN(parsed)) setBaseBudget(parsed);
    }
    fetchBudgetData();
  }, []);

  useEffect(() => { 
    fetchBudgetData(); 
  }, [baseBudget]);

  // カレンダーの日付変更時の過去メニュー呼び出し
  useEffect(() => {
    const targetTitle = `AI相談 (${selectedYear}年${selectedMonth}月${selectedDay}日)`;
    const found = history.find(item => item.name === targetTitle && item.rawAiResponse);
    
    if (found && found.rawAiResponse) {
      setArchivedMenu(found.rawAiResponse);
      parseShoppingList(found.rawAiResponse);
    } else {
      setArchivedMenu(null);
      if (!aiResponse) setShoppingSections([]);
    }
  }, [selectedYear, selectedMonth, selectedDay, history]);

  // 履歴（history）が更新されたら、自動的によく行くお店を4つ抽出する
  useEffect(() => {
    if (history.length === 0) {
      // 履歴が空の時のデフォルトのモック
      setDynamicShops([
        { label: "🛒 ウオロク", itemName: "ウオロク", category: "自炊", defaultPrice: "2000" },
        { label: "🍱 社食弁当", itemName: "社食弁当", category: "会社の弁当", defaultPrice: "274" }
      ]);
      return;
    }

    const uniqueShops: Record<string, { rawName: string; category: CategoryType; count: number; lastPrice: number }> = {};
    
    // 支出があるデータ（金額>0で、AI相談以外の純粋な記録）から集計
    history.forEach(item => {
      if (item.price > 0 && item.rawNameOnly && !item.name.includes("AI相談")) {
        const key = `${item.rawNameOnly}_${item.category}`;
        if (uniqueShops[key]) {
          uniqueShops[key].count += 1;
        } else {
          uniqueShops[key] = {
            rawName: item.rawNameOnly,
            category: item.category,
            count: 1,
            lastPrice: item.price
          };
        }
      }
    });

    // 登場回数が多い順にソートして最大4つ取得
    const sortedShops = Object.values(uniqueShops)
      .sort((a, b) => b.count - a.count)
      .slice(0, 4)
      .map(shop => {
        let emoji = "🛒";
        if (shop.category === "外食") emoji = "🍔";
        if (shop.category === "買い食い") emoji = "🏪";
        if (shop.category === "会社の弁当") emoji = "🍱";

        // 💡 会社の弁当、または品名に「弁当」「社食」が入っていたら274円に強制固定
        const isBento = shop.category === "会社の弁当" || shop.rawName.includes("弁当") || shop.rawName.includes("社食");
        const priceStr = isBento ? "274" : shop.lastPrice.toString();

        return {
          label: `${emoji} ${shop.rawName}`,
          itemName: shop.rawName,
          category: shop.category,
          defaultPrice: priceStr
        };
      });

    // もし社食弁当の登録がまだ履歴になければ、出しやすくするためにデフォルトで仕込んでおく
    const hasBentoPreset = sortedShops.some(s => s.category === "会社の弁当");
    if (!hasBentoPreset && sortedShops.length < 4) {
      sortedShops.push({ label: "🍱 社食弁当", itemName: "社食弁当", category: "会社の弁当", defaultPrice: "274" });
    }

    setDynamicShops(sortedShops);
  }, [history]);

  const parseShoppingList = (text: string) => {
    try {
      const parts = text.split(/##\s*🛒\s*買い物リスト/i);
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
  };

  useEffect(() => {
    if (aiResponse) parseShoppingList(aiResponse);
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
          else if (nameStr.includes('[会社の弁当]')) detectedCategory = '会社の弁当';
          else if (nameStr.includes('[その他]')) detectedCategory = 'その他';

          // [カテゴリー] を除いた純粋な店名・品名を抽出
          const rawNameOnly = nameStr.replace(/^\[.*?\]\s*/, '');

          return {
            id: item.id, 
            name: nameStr, 
            rawNameOnly: rawNameOnly,
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
    let price = parseInt(expense); 
    
    // 💡 登録時も、もし「会社の弁当」が選択されていれば、強制的に274円にする親切設計
    if (activeCategory === '会社の弁当') {
      price = 274;
    }

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

  // 💡 カテゴリー切り替え時、もし「会社の弁当」が手動タップされたら274円を自動セット
  const handleCategoryChange = (cat: CategoryType) => {
    setActiveCategory(cat);
    if (cat === '会社の弁当') {
      setExpense("274");
      if(!itemName) setItemName("社食弁当");
    }
  };

  // 💡 よく行くお店（動的プリセット）をタップした時のセット処理
  const handleApplyDynamicPreset = (shop: DynamicShop) => {
    setItemName(shop.itemName);
    setActiveCategory(shop.category);
    setExpense(shop.defaultPrice);
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
    const categories: CategoryType[] = ['自炊', '外食', '買い食い', '会社の弁当', 'その他'];
    return categories.map(cat => {
      const sum = history.filter(h => h.name.includes(`[${cat}]`)).reduce((a, b) => a + b.price, 0);
      return { category: cat, total: sum };
    });
  };

  const resetData = async () => {
    if (!confirm("データをフルリセットする？")) return;
    const { error } = await supabase.from('budgets').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    if (!error) { setAiResponse(""); setHistory([]); setStock(""); setArchivedMenu(null); fetchBudgetData(); }
  };

  const askGemini = async () => {
    setLoading(true);
    try {
      const genAI = new GoogleGenerativeAI(process.env.NEXT_PUBLIC_GEMINI_API_KEY || "");
      const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
      const targetDateStr = `${selectedYear}年${selectedMonth}月${selectedDay}日`;
      const prompt = `あなたは節約料理のプロです。指定のフォーマットで出力してください。\n【目標日】${targetDateStr}\n【冷蔵庫にある余り物】${stock}\n【ユーザーからのリクエスト】${userRequest}\n\n【出力フォーマット】\n### ${targetDateStr} の献立計画\n**メニュー名**\n・手順やコツをここに簡潔に書く\n\n## 🛒 買い物リスト\n### 【肉・魚類】\n- 食材名\n### 【野菜・その他】\n- 食材名\n### 【調味料】\n- 調味料名`;
      
      const result = await model.generateContent(prompt);
      const text = result.response.text();
      setAiResponse(text); 
      setArchivedMenu(text);
      setActiveTab('menu');
      await supabase.from('budgets').insert([{ budget_amount: budget, item_name: `AI相談 (${targetDateStr})`, expense_price: 0, stock_items: stock, user_request: userRequest, ai_response: text }]);
      fetchBudgetData();
    } catch (err: any) { alert(err.message); }
    setLoading(false);
  };

  const formatMenuContent = (rawText: string) => {
    return rawText.split('\n').map((line, idx) => {
      const trimmed = line.trim(); if (!trimmed) return <div key={idx} className="h-2"></div>;
      if (trimmed.startsWith('###')) return <div key={idx} className="text-xs font-bold text-cyan-400 mt-2 border-b border-cyan-900 pb-1">{trimmed.replace(/###/g, '')}</div>;
      if (trimmed.startsWith('**') && trimmed.endsWith('**')) return <div key={idx} className="text-sm font-bold text-white mt-4 mb-1 border-l-2 border-cyan-500 pl-2">🍳 {trimmed.replace(/\*\*/g, '')}</div>;
      if (trimmed.startsWith('・') || trimmed.startsWith('-') || /^\d/.test(trimmed)) return <div key={idx} className="text-xs text-gray-300 pl-4 py-1 bg-zinc-900/60 rounded my-1">{trimmed.replace(/^[\s・\-\d\.]+\s*/, '👉 ')}</div>;
      return <div key={idx} className="text-xs text-gray-400 pl-2">{trimmed}</div>;
    });
  };

  const renderMonthCalendar = () => {
    const daysInMonth = new Date(selectedYear, selectedMonth, 0).getDate();
    const dayButtons = [];
    
    for (let d = 1; d <= daysInMonth; d++) {
      const dateObj = new Date(selectedYear, selectedMonth - 1, d);
      const dayJa = DAY_MAP_ENG_TO_JA[dateObj.getDay()];
      const isSelected = selectedDay === d;
      const hasMenu = history.some(item => item.name === `AI相談 (${selectedYear}年${selectedMonth}月${d}日)`);
      
      dayButtons.push(
        <button key={d} type="button" onClick={() => setSelectedDay(d)} className={`flex flex-col items-center justify-center p-1.5 rounded-xl border font-mono text-xs transition-all ${isSelected ? 'bg-cyan-600 text-white border-cyan-500 font-bold' : 'bg-zinc-950 text-gray-400 border-zinc-900/50 hover:bg-zinc-900'} relative`}>
          <span className="text-[8px] opacity-60 font-sans">{dayJa}</span>
          <span>{d}</span>
          {hasMenu && <div className="absolute bottom-1 w-1 h-1 bg-cyan-400 rounded-full"></div>}
        </button>
      );
    }

    return (
      <div className="bg-zinc-900/80 p-4 rounded-3xl border border-zinc-800 space-y-3">
        <div className="flex justify-between items-center px-1">
          <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Calendar Target</label>
          <div className="flex gap-2">
            <select value={selectedYear} onChange={(e) => setSelectedYear(parseInt(e.target.value))} className="bg-black border border-zinc-800 rounded-lg text-xs px-2 py-1 text-white font-mono">
              {[2026, 2027, 2028].map(y => <option key={y} value={y}>{y}年</option>)}
            </select>
            <select value={selectedMonth} onChange={(e) => { setSelectedMonth(parseInt(e.target.value)); setSelectedDay(1); }} className="bg-black border border-zinc-800 rounded-lg text-xs px-2 py-1 text-white font-mono">
              {Array.from({ length: 12 }, (_, i) => i + 1).map(m => <option key={m} value={m}>{m}月</option>)}
            </select>
          </div>
        </div>
        <div className="grid grid-cols-7 gap-1 max-h-[160px] overflow-y-auto pr-1">{dayButtons}</div>
        <div className="text-center text-[10px] font-bold text-cyan-400 bg-zinc-950 py-1 rounded-xl border border-zinc-900">選択中: {selectedYear}年{selectedMonth}月{selectedDay}日</div>
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-black text-gray-200 p-6 font-sans pb-20">
      <header className="max-w-md mx-auto mb-8 text-center">
        <h1 className="text-4xl font-bold text-cyan-400 italic">BudgetBite <span className="text-xs bg-cyan-900 px-2 py-0.5 rounded-full">v3.8</span></h1>
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

        {/* 💰 出費入力 ＋ 🏪 動的なお気に入り選択 */}
        <div className="bg-zinc-900/40 p-4 rounded-3xl border border-zinc-800 space-y-3">
          <div className="flex gap-1 bg-black p-1 rounded-xl border border-zinc-900">
            {(['自炊', '外食', '買い食い', '会社の弁当'] as CategoryType[]).map(cat => (
              <button key={cat} type="button" onClick={() => handleCategoryChange(cat)} className={`flex-1 py-1.5 rounded-lg text-[9px] font-bold transition-all ${activeCategory === cat ? 'bg-zinc-800 text-white border border-zinc-700' : 'text-gray-600'}`}>{cat}</button>
            ))}
          </div>
          <form onSubmit={addExpense} className="flex gap-2">
            <input type="text" value={itemName} onChange={(e)=>setItemName(e.target.value)} placeholder="品名(任意)" className="flex-1 bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-2 text-white text-xs focus:outline-none"/>
            <input type="number" value={expense} onChange={(e)=>setExpense(e.target.value)} placeholder="金額" className="w-24 bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-2 text-white font-mono text-lg focus:outline-none"/>
            <button type="submit" className="bg-white text-black px-4 rounded-xl font-bold text-xs">記録</button>
          </form>

          {/* 💡 履歴からよく行くお店を自動生成するエリア */}
          <div className="pt-2 border-t border-zinc-900">
            <p className="text-[9px] font-bold text-gray-500 uppercase tracking-widest mb-2 pl-1">よく行くお店（履歴から自動登録）</p>
            <div className="grid grid-cols-4 gap-1.5">
              {dynamicShops.map((shop, idx) => (
                <button key={idx} type="button" onClick={() => handleApplyDynamicPreset(shop)} className="bg-zinc-950 border border-zinc-900 hover:border-zinc-700 py-2 px-1 rounded-xl text-[10px] text-gray-300 font-bold transition-all truncate text-center">
                  {shop.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* 📅 カレンダー */}
        {renderMonthCalendar()}

        {/* 🍽️ メメニュー表示エリア */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-3xl p-5 shadow-2xl space-y-4">
          <div className="flex gap-1 bg-zinc-950 p-1 rounded-xl border border-zinc-800">
            <button type="button" onClick={() => setActiveTab('menu')} className={`flex-1 py-2 rounded-lg font-bold text-[10px] ${activeTab === 'menu' ? 'bg-cyan-600 text-white' : 'text-gray-500'}`}>📅 選択日の献立</button>
            <button type="button" onClick={() => setActiveTab('shopping')} className={`flex-1 py-2 rounded-lg font-bold text-[10px] ${activeTab === 'shopping' ? 'bg-cyan-600 text-white' : 'text-gray-500'}`}>🛒 買い物リスト</button>
            <button type="button" onClick={() => setActiveTab('stats')} className={`flex-1 py-2 rounded-lg font-bold text-[10px] ${activeTab === 'stats' ? 'bg-cyan-600 text-white' : 'text-gray-500'}`}>📊 今月の分析</button>
          </div>
          
          <div className="text-gray-300 text-sm max-h-[350px] overflow-y-auto">
            {activeTab === 'menu' && (
              <div className="bg-zinc-950 p-4 rounded-2xl border border-zinc-800 min-h-[100px]">
                {archivedMenu ? formatMenuContent(archivedMenu) : (
                  <div className="text-center text-xs text-gray-500 py-6">選択した日の献立計画はまだありません。<br/>下のフォームからAIに相談してみてね！</div>
                )}
              </div>
            )}

            {activeTab === 'shopping' && (
              <div className="space-y-4">
                {shoppingSections.length > 0 ? shoppingSections.map((sec, sIdx) => (
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
                )) : <div className="text-center text-xs text-gray-500 py-6">買い物リストがありません。</div>}
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
                <p className="text-[9px] text-gray-600 italic mt-6">*自炊と会社の弁当の比率を高めて、規律ある食生活を目指しましょう！</p>
              </div>
            )}
          </div>
        </div>

        {/* 🛠️ AIプランニング入力 */}
        <div className="bg-zinc-900/40 p-4 rounded-3xl border border-zinc-800 space-y-4">
          <div className="text-[10px] font-bold text-gray-500 uppercase tracking-widest px-1">AI Planning Form</div>
          <input type="text" value={stock} onChange={(e)=>setStock(e.target.value)} placeholder="在庫リスト（冷蔵庫に入れると自動追記）" className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-3 text-white text-xs focus:outline-none"/>
          <textarea value={userRequest} onChange={(e)=>setUserRequest(e.target.value)} placeholder="AIへの要望（例：パパッと作れる時短モードで！）" className="w-full h-16 bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-2 text-white text-xs focus:outline-none resize-none"/>
          <button type="button" onClick={askGemini} disabled={loading} className="w-full py-5 bg-gradient-to-r from-cyan-600 to-blue-600 text-white rounded-2xl font-bold shadow-xl disabled:opacity-50">{loading ? "Gemini思考中..." : "選択した日の献立を新しくAIに相談する"}</button>
        </div>

        {/* 最近のアクティビティ */}
        <div className="bg-zinc-900/30 rounded-2xl p-4 border border-zinc-800 space-y-3">
          <p className="text-[10px] font-bold text-gray-500 uppercase tracking-widest px-1">Recent Activity</p>
          {history.slice(0, 5).map(item => (
            <div key={item.id} className="flex justify-between items-center text-xs pb-1 border-b border-zinc-900 last:border-0">
               <span className="text-gray-400 truncate max-w-[200px]">{item.name}</span>
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