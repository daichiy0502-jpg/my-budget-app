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

interface FavoriteShop { id: string; label: string; itemName: string; category: CategoryType; defaultPrice: string; }

const DAY_MAP_ENG_TO_JA: Record<number, string> = { 0: '日', 1: '月', 2: '火', 3: '水', 4: '木', 5: '金', 6: '土' };
const DAYS_OF_WEEK = ['日', '月', '火', '水', '木', '金', '土'];

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

  // 📅 週一括プランニング用の選択曜日ステータス (日〜土)
  const [selectedWeekDays, setSelectedWeekDays] = useState<boolean[]>([false, true, true, true, true, true, false]);

  // 🤖 AI・表示データ
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [aiResponse, setAiResponse] = useState("");
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<ActiveTabType>('menu');
  const [shoppingSections, setShoppingSections] = useState<ShoppingSection[]>([]);
  const [archivedMenu, setArchivedMenu] = useState<string | null>(null);

  // ⭐️ お気に入りのお店リスト
  const [favoriteShops, setFavoriteShops] = useState<FavoriteShop[]>([]);

  useEffect(() => {
    const savedBase = localStorage.getItem('budgetbite_base_budget');
    if (savedBase) {
      const parsed = parseInt(savedBase);
      if (!isNaN(parsed)) setBaseBudget(parsed);
    }
    
    const savedShops = localStorage.getItem('budgetbite_favorite_shops');
    if (savedShops) {
      setFavoriteShops(JSON.parse(savedShops));
    } else {
      const defaultShops: FavoriteShop[] = [
        { id: 'default-bento', label: "🍱 社食弁当", itemName: "社食弁当", category: "会社の弁当", defaultPrice: "274" }
      ];
      setFavoriteShops(defaultShops);
      localStorage.setItem('budgetbite_favorite_shops', JSON.stringify(defaultShops));
    }

    fetchBudgetData();
  }, []);

  useEffect(() => { 
    fetchBudgetData(); 
  }, [baseBudget]);

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
          if (name.length > 0 && name.length < 50) { 
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
    if (activeCategory === '会社の弁当') price = 274;

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

  const addCurrentToFavorites = () => {
    if (!itemName.trim()) return alert("お店の名前（品名）を入力してね！");
    let finalPrice = expense;
    if (activeCategory === '会社の弁当') finalPrice = "274";

    let emoji = "🛒";
    if (activeCategory === "外食") emoji = "🍔";
    if (activeCategory === "買い食い") emoji = "🏪";
    if (activeCategory === "会社の弁当") emoji = "🍱";

    const newShop: FavoriteShop = {
      id: `shop-${Date.now()}`,
      label: `${emoji} ${itemName}`,
      itemName: itemName,
      category: activeCategory,
      defaultPrice: finalPrice || "0"
    };

    const updated = [...favoriteShops, newShop];
    setFavoriteShops(updated);
    localStorage.setItem('budgetbite_favorite_shops', JSON.stringify(updated));
    alert(`${itemName} をお気に入りに登録したよ！`);
  };

  const deleteFavoriteShop = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm("このお店をお気に入りから削除する？")) return;
    const updated = favoriteShops.filter(shop => shop.id !== id);
    setFavoriteShops(updated);
    localStorage.setItem('budgetbite_favorite_shops', JSON.stringify(updated));
  };

  const handleCategoryChange = (cat: CategoryType) => {
    setActiveCategory(cat);
    if (cat === '会社の弁当') {
      setExpense("274");
      if(!itemName) setItemName("社食弁当");
    }
  };

  const handleApplyFavorite = (shop: FavoriteShop) => {
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

  // 💡 通常の単日AI相談（調味料絶対網羅・ウルトラプロンプト）
  const askGemini = async () => {
    setLoading(true);
    try {
      const genAI = new GoogleGenerativeAI(process.env.NEXT_PUBLIC_GEMINI_API_KEY || "");
      const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
      const targetDateStr = `${selectedYear}年${selectedMonth}月${selectedDay}日`;
      
      const prompt = `あなたは節約料理のプロです。指定のフォーマットで出力してください。

【⚠️超最重要ルール：調味料は完全省略禁止⚠️】
調理で使用する調味料は、どんなに基礎的で一般家庭に必ず常備されていると思われるものであっても、一切の省略をせず、全て【調味料】リストに載せてください。
（例：塩、コショウ、醤油、砂糖、サラダ油、ごま油、酢、みりん、料理酒、マヨネーズ、ケチャップ、だしの素、めんつゆ、ポン酢、チューブのニンニクや生姜など、少しでも使うならすべて一文字たりとも省略せずにリストアップすること。「家にあるものは省略する」といった配慮や手抜きは絶対に許しません。）

【目標日】${targetDateStr}
【冷蔵庫にある余り物】${stock}
【ユーザーからのリクエスト】${userRequest}

【出力フォーマット】
### ${targetDateStr} の献立計画
**メニュー名**
・手順やコツをここに簡潔に書く

## 🛒 買い物リスト
### 【肉・魚類】
- 食材名
### 【野菜・その他】
- 食材名
### 【調味料】
- 調味料名（塩、油、醤油なども調理に使うものは一文字も省略せずすべて個別に載せること）`;
      
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

  // 💡 週一括プランニング機能（調味料絶対網羅・ウルトラプロンプト）
  const askGeminiWeekly = async () => {
    const selectedIndexes = selectedWeekDays.map((v, i) => v ? i : -1).filter(i => i !== -1);
    if (selectedIndexes.length === 0) return alert("一括生成したい曜日を少なくとも1つ選んでね！");

    setLoading(true);
    try {
      const currentSelectedDate = new Date(selectedYear, selectedMonth - 1, selectedDay);
      const currentDayOfWeek = currentSelectedDate.getDay(); 
      
      const sundayDate = new Date(currentSelectedDate);
      sundayDate.setDate(currentSelectedDate.getDate() - currentDayOfWeek);

      const weekDatesMap = selectedIndexes.map(idx => {
        const d = new Date(sundayDate);
        d.setDate(sundayDate.getDate() + idx);
        return {
          dayName: DAYS_OF_WEEK[idx],
          dateStr: `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`
        };
      });

      const targetDaysLine = weekDatesMap.map(m => `${m.dateStr}(${m.dayName})`).join(', ');

      const genAI = new GoogleGenerativeAI(process.env.NEXT_PUBLIC_GEMINI_API_KEY || "");
      const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

      const prompt = `あなたは超優秀な節約料理のプロです。指定された複数の曜日分の献立計画と、それらを作るための【全ての合計買い物リスト】を一括で出力してください。
不要な挨拶や説明は一切省き、指定フォーマットを厳密に守ってください。

【⚠️超最重要ルール：調味料は完全省略禁止⚠️】
作成するすべての献立で消費する調味料は、一般家庭に常備されている定番のものであっても、一切省略せずに【調味料】リストへ合算して完全にすべて書き出してください。
（例：塩、コショウ、醤油、砂糖、サラダ油、ごま油、酢、みりん、料理酒、マヨネーズ、ケチャップ、だしの素、コンソメ、鶏ガラスープの素、めんつゆ、にんにくチューブ等、レシピで少しでも使うものは必ずリストアップすること。「基本調味料は家にある前提で省略する」ことは絶対に厳禁とし、不合格とします。）

【計画対象日】${targetDaysLine}
【冷蔵庫にある余り物】${stock}
【ユーザーからの要望】${userRequest}

【出力フォーマット】
### [日付文字列] の献立計画
**メニュー名**
・手順やコツを簡潔に書く

## 🛒 買い物リスト
### 【肉・魚類】
- 食材名
### 【野菜・その他】
- 食材名
### 【調味料】
- 調味料名（使用する塩、醤油、油、その他すべての調味料を漏れなく一文字も省略せず完全に羅列すること）`;

      const result = await model.generateContent(prompt);
      const fullText = result.response.text();

      const shoppingPart = fullText.split(/##\s*🛒\s*買い物リスト/i)[1] || "";

      for (const mapObj of weekDatesMap) {
        const escapedDate = mapObj.dateStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`###\\s*${escapedDate}[\\s\\S]*?(?=###|##\\s*🛒|$)`, 'i');
        const match = fullText.match(regex);
        
        let dayMenuText = `### ${mapObj.dateStr} の献立計画\n**一括プランニングメニュー**\n・詳細は全体の買い物リストを確認してね！`;
        if (match && match[0]) {
          dayMenuText = match[0].trim();
        }

        const finalDayResponse = `${dayMenuText}\n\n## 🛒 買い物リスト\n${shoppingPart}`;

        await supabase.from('budgets').insert([{
          budget_amount: budget,
          item_name: `AI相談 (${mapObj.dateStr})`,
          expense_price: 0,
          stock_items: stock,
          user_request: `[一括作成] ${userRequest}`,
          ai_response: finalDayResponse
        }]);
      }

      setAiResponse(fullText);
      setArchivedMenu(fullText);
      setActiveTab('menu');
      alert("選択した曜日すべての献立計画を一括作成してカレンダーに保存したよ！調味料もフルカバーしてるよ。");
      fetchBudgetData();

    } catch (err: any) { alert(err.message); }
    setLoading(false);
  };

  const toggleWeekDay = (index: number) => {
    const updated = [...selectedWeekDays];
    updated[index] = !updated[index];
    setSelectedWeekDays(updated);
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
        <h1 className="text-4xl font-bold text-cyan-400 italic">BudgetBite <span className="text-xs bg-cyan-900 px-2 py-0.5 rounded-full">v4.2</span></h1>
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

        {/* 💰 出費入力 ＋ ⭐ お気に入り */}
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

          {/* ⭐️ お気に入り登録・呼び出し */}
          <div className="pt-2 border-t border-zinc-900 space-y-2">
            <div className="flex justify-between items-center px-1">
              <p className="text-[9px] font-bold text-gray-500 uppercase tracking-widest">よく行くお店（お気に入り選択）</p>
              <button type="button" onClick={addCurrentToFavorites} className="text-[9px] bg-cyan-900/40 border border-cyan-800/60 text-cyan-400 font-bold px-2 py-0.5 rounded-lg hover:bg-cyan-800 transition-all">
                いまの入力を登録 ⭐️
              </button>
            </div>
            
            <div className="grid grid-cols-3 gap-1.5">
              {favoriteShops.map((shop) => (
                <div key={shop.id} className="relative group">
                  <button type="button" onClick={() => handleApplyFavorite(shop)} className="w-full bg-zinc-950 border border-zinc-900 hover:border-zinc-700 py-2.5 px-1 rounded-xl text-[10px] text-gray-300 font-bold transition-all truncate text-center pr-4">
                    {shop.label}
                  </button>
                  <button type="button" onClick={(e) => deleteFavoriteShop(shop.id, e)} className="absolute top-1 right-1 text-[8px] text-gray-600 hover:text-red-400 px-0.5" title="削除">
                    ✕
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* 📅 カレンダー */}
        {renderMonthCalendar()}

        {/* 🍽️ メニュー表示 */}
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
              </div>
            )}
          </div>
        </div>

        {/* 🛠️ AIプランニング入力 (通常 ＆ 週一括ハイブリッド) */}
        <div className="bg-zinc-900/40 p-4 rounded-3xl border border-zinc-800 space-y-4">
          <div className="text-[10px] font-bold text-gray-500 uppercase tracking-widest px-1">AI Planning Form</div>
          <input type="text" value={stock} onChange={(e)=>setStock(e.target.value)} placeholder="在庫リスト（冷蔵庫に入れると自動追記）" className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-3 text-white text-xs focus:outline-none"/>
          <textarea value={userRequest} onChange={(e)=>setUserRequest(e.target.value)} placeholder="AIへの要望（例：パパッと作れる時短モードで！）" className="w-full h-16 bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-2 text-white text-xs focus:outline-none resize-none"/>
          
          <div className="flex gap-1">
            <button type="button" onClick={askGemini} disabled={loading} className="flex-1 py-4 bg-zinc-900 border border-zinc-800 text-gray-300 rounded-2xl font-bold text-xs shadow-xl disabled:opacity-50">
              {loading ? "思考中..." : "選択日のみ作成"}
            </button>
            <button type="button" onClick={askGeminiWeekly} disabled={loading} className="flex-[2] py-4 bg-gradient-to-r from-cyan-600 to-blue-600 text-white rounded-2xl font-bold text-xs shadow-xl disabled:opacity-50">
              {loading ? "一括生成中..." : "選んだ曜日分を一括生成 🗓️"}
            </button>
          </div>

          {/* 🗓️ 週一括用の曜日選択 */}
          <div className="bg-black/40 p-3 rounded-2xl border border-zinc-900 space-y-2">
            <p className="text-[9px] font-bold text-gray-500 uppercase tracking-widest text-center">一括生成する対象の曜日を選択</p>
            <div className="flex justify-between gap-1">
              {DAYS_OF_WEEK.map((day, idx) => (
                <button key={day} type="button" onClick={() => toggleWeekDay(idx)} className={`flex-1 py-2 rounded-lg font-mono text-[10px] font-bold transition-all border ${selectedWeekDays[idx] ? 'bg-cyan-950 text-cyan-400 border-cyan-800' : 'bg-zinc-950 text-gray-600 border-zinc-900'}`}>
                  {day}
                </button>
              ))}
            </div>
          </div>
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

        <div className="text-center pt-8"><button type="button" onClick={resetData} className="text-zinc-800 text-[9px] uppercase tracking-widest font-bold">Factory Factory Reset</button></div>
      </main>
    </div>
  );
}