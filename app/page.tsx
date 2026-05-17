"use client";
import React, { useState, useEffect } from 'react';
import { GoogleGenerativeAI } from "@google/generative-ai";
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
const supabase = createClient(supabaseUrl, supabaseAnonKey);

interface ShoppingItem { id: string; name: string; checked: boolean; inStock?: boolean; }
interface ShoppingSection { title: string; items: ShoppingItem[]; }
interface MenuDay { day: string; content: string; }
interface HistoryItem { id: string; name: string; price: number; date: string; rawAiResponse?: string; year: number; month: number; rawDateObj: Date; }

type ActiveTabType = 'menu' | 'shopping' | 'stats';
type CategoryType = '自炊' | '外食' | '買い食い' | '会社の弁当' | 'その他';
interface FavoriteShop { id: string; label: string; itemName: string; category: CategoryType; defaultPrice: string; }

// 📅 月曜始まり用の曜日マップ
const DAY_MAP_ENG_TO_JA: Record<number, string> = { 1: '月', 2: '火', 3: '水', 4: '木', 5: '金', 6: '土', 0: '日' };

export default function BudgetBiteAI() {
  // 💰 予算・ステータス
  const [baseBudget, setBaseBudget] = useState<number>(25000);
  const [isEditingBaseBudget, setIsEditingBaseBudget] = useState(false);
  const [inputBaseBudget, setInputBaseBudget] = useState("");
  const [budget, setBudget] = useState(25000);

  // 🤖 AI残り回数 (無料枠の上限20回から逆算)
  const [aiRemainingCount, setAiRemainingCount] = useState<number>(20);

  // 📝 入力フォーム
  const [itemName, setItemName] = useState("");
  const [expense, setExpense] = useState("");
  const [activeCategory, setActiveCategory] = useState<CategoryType>('自炊');
  const [stock, setStock] = useState(""); 
  const [userRequest, setUserRequest] = useState("平日の夜に時間がなくてもパパッと作れる時短レシピにして！");
  
  // 📅 カレンダー制御
  const [selectedYear, setSelectedYear] = useState<number>(new Date().getFullYear());
  const [selectedMonth, setSelectedMonth] = useState<number>(new Date().getMonth() + 1);
  const [selectedDays, setSelectedDays] = useState<number[]>([new Date().getDate()]);

  // 📊 分析データの集計範囲指定
  const [statsPeriod, setStatsPeriod] = useState<'all' | 'year' | 'month'>('month');
  const [statsYear, setStatsYear] = useState<number>(new Date().getFullYear());
  const [statsMonth, setStatsMonth] = useState<number>(new Date().getMonth() + 1);

  // 🤖 AI・表示データ
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [aiResponse, setAiResponse] = useState("");
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<ActiveTabType>('menu');
  const [shoppingSections, setShoppingSections] = useState<ShoppingSection[]>([]);
  const [menuDays, setMenuDays] = useState<MenuDay[]>([]);
  const [activeDay, setActiveDay] = useState<string>("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingPrice, setEditingPrice] = useState<string>("");

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

  // カレンダー選択日変更時に、その日のAI献立履歴を復元する
  useEffect(() => {
    if (selectedDays.length === 0) {
      setAiResponse("");
      return;
    }

    const found = history.find(item => {
      if (!item.name.startsWith('AI相談') || !item.rawAiResponse) return false;
      return selectedDays.some(d => item.name.includes(`${selectedYear}年${selectedMonth}月${d}日`));
    });
    
    if (found && found.rawAiResponse) {
      setAiResponse(found.rawAiResponse);
    } else {
      setAiResponse("");
    }
  }, [selectedYear, selectedMonth, selectedDays, history]);

  useEffect(() => {
    if (!aiResponse) {
      setShoppingSections([]); setMenuDays([]); setActiveDay(""); return;
    }
    try {
      // 📅 1. 献立テキストの曜日・日付分解
      const menuPart = aiResponse.split(/##\s*🛒\s*買い物リスト/i)[0];
      const menuLines = menuPart.split('\n');
      const parsedDays: MenuDay[] = [];
      let currentDayName = "";
      let currentDayText: string[] = [];
      
      menuLines.forEach((line) => {
        const trimmed = line.trim();
        if (!trimmed) { if (currentDayName) currentDayText.push(line); return; }
        
        if (trimmed.startsWith('###')) {
          if (currentDayName && currentDayText.length > 0) {
            parsedDays.push({ day: currentDayName, content: currentDayText.join('\n').trim() });
          }
          currentDayName = trimmed.replace(/###/g, '').trim(); 
          currentDayText = [line]; 
        } else if (currentDayName) { 
          currentDayText.push(line); 
        }
      });
      if (currentDayName && currentDayText.length > 0) {
        parsedDays.push({ day: currentDayName, content: currentDayText.join('\n').trim() });
      }
      setMenuDays(parsedDays);
      
      if (parsedDays.length > 0) {
        setActiveDay(parsedDays[0].day); 
      }

      // 🛒 2. 買い物リストのパース
      const parts = aiResponse.split(/##\s*🛒\s*買い物リスト/i);
      if (parts.length < 2) { setShoppingSections([]); return; }
      
      // 📝 下準備セクションが含まれる場合もあるため、純粋な買い物部分をパース
      const shoppingText = parts[1].split(/##\s*⏳\s*翌日に向けた下準備/i)[0];
      const lines = shoppingText.split('\n');
      const parsedSections: ShoppingSection[] = [];
      let currentSectionIdx = -1;

      for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
        const line = lines[lineIdx];
        const trimmed = line.trim();
        if (!trimmed) continue;
        
        if (trimmed.includes('常備品') || trimmed.includes('想定') || trimmed.startsWith('※')) {
          continue;
        }

        const isHeader = trimmed.includes('【') && trimmed.includes('】');
        
        if (isHeader) {
          const cleanTitle = trimmed.replace(/###|##|#|\*\*|・|\-|【|】/g, '').trim();
          parsedSections.push({ title: `【${cleanTitle}】`, items: [] });
          currentSectionIdx = parsedSections.length - 1;
        } else if (currentSectionIdx >= 0) {
          const isBulletPoint = /^[\s\-\*・\d\.]/.test(trimmed);
          
          if (isBulletPoint) {
            let itemNameClean = trimmed.replace(/^[\s\-\*・\d\.]+/, '').replace(/\*\转/g, '').replace(/\*\**/g, '').trim();
            if (itemNameClean.startsWith('(') || itemNameClean.startsWith('（')) continue;

            if (itemNameClean.length > 0 && itemNameClean.length < 20) {
              parsedSections[currentSectionIdx].items.push({ 
                id: `item-${currentSectionIdx}-${lineIdx}`, 
                name: itemNameClean, 
                checked: false,
                inStock: false
              });
            }
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

        const parsedHistory = data.map((item): HistoryItem => {
          const dObj = new Date(item.created_at);
          return {
            id: item.id, 
            name: item.item_name || "買い物", 
            price: item.expense_price || 0,
            rawAiResponse: item.ai_response || undefined,
            year: dObj.getFullYear(),
            month: dObj.getMonth() + 1,
            rawDateObj: dObj,
            date: dObj.toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric' }) + " " + 
                  dObj.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })
          };
        });

        setHistory(parsedHistory);

        const todayStr = new Date().toLocaleDateString('ja-JP'); 
        const todayAiCount = data.filter(item => {
          const isAi = item.item_name && item.item_name.startsWith('AI相談');
          const isToday = new Date(item.created_at).toLocaleDateString('ja-JP') === todayStr;
          return isAi && isToday;
        }).length;
        
        setAiRemainingCount(Math.max(0, 20 - todayAiCount));
        
        const now = new Date();
        const tYear = now.getFullYear();
        const tMonth = now.getMonth() + 1;
        const tDay = now.getDate();
        const targetTodayString = `${tYear}年${tMonth}月${tDay}日`;

        const todayAiLog = parsedHistory.find(item => item.name.startsWith('AI相談') && item.name.includes(targetTodayString) && item.rawAiResponse);
        
        if (todayAiLog && todayAiLog.rawAiResponse) {
          setAiResponse(todayAiLog.rawAiResponse);
          setActiveTab('menu');
          const matchingBudgetLog = data.find(item => item.id === todayAiLog.id);
          if (matchingBudgetLog) {
            setStock(matchingBudgetLog.stock_items || "");
            setUserRequest(matchingBudgetLog.user_request || userRequest);
          }
        } else {
          const lastAi = data.find(item => item.ai_response);
          if (lastAi && !aiResponse) { 
            setAiResponse(lastAi.ai_response); 
            setStock(lastAi.stock_items || ""); 
            setUserRequest(lastAi.user_request || userRequest); 
          }
        }
      }
    } catch (e) { console.error(e); }
  };

  const addExpense = async (e: React.FormEvent) => {
    e.preventDefault(); 
    let price = activeCategory === '会社の弁当' ? 274 : parseInt(expense); 
    const finalItemName = activeCategory === '会社の弁当' ? (itemName || "社食弁当") : itemName;
    const finalName = `[${activeCategory}] ${finalItemName || "買い物"}`;
    if (isNaN(price) || price <= 0) return alert("金額を正しく入力してね！");
    
    const { error } = await supabase.from('budgets').insert([{ 
      budget_amount: budget - price, 
      item_name: finalName, 
      expense_price: price, 
      stock_items: stock, 
      user_request: userRequest, 
      ai_response: aiResponse 
    }]);
    
    if (!error) { 
      setActiveCategory('自炊'); 
      setExpense(""); 
      setItemName(""); 
      fetchBudgetData(); 
    }
  };

  const addCurrentToFavorites = () => {
    if (!itemName.trim() && activeCategory !== '会社の弁当') return alert("お店の名前（品名）を入力してね！");
    let finalItemName = itemName;
    let finalPrice = expense;
    if (activeCategory === '会社の弁当') {
      finalItemName = itemName || "社食弁当";
      finalPrice = "274";
    }

    let emoji = "🛒";
    if (activeCategory === "外食") emoji = "🍔";
    if (activeCategory === "買い食い") emoji = "🏪";
    if (activeCategory === "会社の弁当") emoji = "🍱";

    const newShop: FavoriteShop = {
      id: `shop-${Date.now()}`,
      label: `${emoji} ${finalItemName}`,
      itemName: finalItemName,
      category: activeCategory,
      defaultPrice: finalPrice || "0"
    };

    const updated = [...favoriteShops, newShop];
    setFavoriteShops(updated);
    localStorage.setItem('budgetbite_favorite_shops', JSON.stringify(updated));
    alert(`${finalItemName} をお気に入りに登録したよ！`);
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
    if (cat === '会社の弁当') setExpense("");
  };

  const handleApplyFavorite = (shop: FavoriteShop) => {
    setItemName(shop.itemName);
    setActiveCategory(shop.category);
    setExpense(shop.defaultPrice);
  };

  const updateExpensePrice = async (id: string) => {
    const newPrice = parseInt(editingPrice); if (isNaN(newPrice) || newPrice < 0) return alert("正しい金額をいれてね");
    const { error } = await supabase.from('budgets').update({ expense_price: newPrice }).eq('id', id);
    if (!error) { setEditingId(null); setEditingPrice(""); fetchBudgetData(); }
  };

  const deleteExpense = async (id: string) => {
    if (!confirm("削除する？")) return;
    const { error } = await supabase.from('budgets').delete().eq('id', id);
    if (!error) fetchBudgetData();
  };

  const saveBaseBudget = () => {
    const parsed = parseInt(inputBaseBudget);
    if (isNaN(parsed) || parsed < 0) return alert("正しい予算額を入力してね！");
    setBaseBudget(parsed);
    localStorage.setItem('budgetbite_base_budget', parsed.toString());
    setIsEditingBaseBudget(false);
  };

  const getStats = () => {
    const categories: CategoryType[] = ['自炊', '外食', '買い食い', '会社の弁当', 'その他'];
    const filteredHistory = history.filter(h => {
      if (statsPeriod === 'all') return true;
      if (statsPeriod === 'year') return h.year === statsYear;
      if (statsPeriod === 'month') return h.year === statsYear && h.month === statsMonth;
      return true;
    });
    return categories.map(cat => {
      const sum = filteredHistory.filter(h => h.name.includes(`[${cat}]`)).reduce((a, b) => a + b.price, 0);
      return { category: cat, total: sum };
    });
  };

  const resetData = async () => {
    if (!confirm("リセットする？")) return;
    const { error } = await supabase.from('budgets').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    if (!error) { setBudget(25000); setAiResponse(""); setHistory([]); setStock(""); setAiRemainingCount(20); }
  };

  const handleDaySelect = (dayNum: number) => {
    if (selectedDays.includes(dayNum)) {
      setSelectedDays(selectedDays.filter(d => d !== dayNum));
    } else {
      setSelectedDays([...selectedDays, dayNum].sort((a, b) => a - b));
    }
  };

  const askGemini = async () => {
    if (selectedDays.length === 0) {
      setLoading(false);
      return alert("カレンダーから献立を立てたい日付を1つ以上選択してね！");
    }
    if (aiRemainingCount <= 0) {
      return alert("本日のAI利用回数（20回）の上限に達したよ！");
    }
    setLoading(true);
    try {
      const genAI = new GoogleGenerativeAI(process.env.NEXT_PUBLIC_GEMINI_API_KEY || "");
      const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
      
      const targetDatesDetailed = selectedDays.map(d => {
        const dayOfWeekEng = new Date(selectedYear, selectedMonth - 1, d).getDay();
        return `${selectedYear}年${selectedMonth}月${d}日(${DAY_MAP_ENG_TO_JA[dayOfWeekEng]})`;
      });
      const targetDateStr = selectedDays.map(d => `${selectedYear}年${selectedMonth}月${d}日`).join(', ');
      
      const prompt = `あなたは優秀な節約料理のプロです。以下の条件に従って、【指定された日付分だけ】の献立、買い物リスト、そして翌日に向けた下準備を、指定のフォーマットで漏れなく作成してください。
選択された日数が1日だけなら1日分、3日なら3日分のみを出力し、指定されていない日付や曜日の献立は【絶対に】含めないでください。
出力の最初から最後まで、フォーマット以外の挨拶、解説、応援メッセージなどの雑談は【絶対に】一切含めないでください。

【条件】
・対象日（この日付以外は出力禁止）：${targetDatesDetailed.join(', ')}
・全体予算：対象日数に応じた現実的な買い出し総額（1日あたり500円程度を目安に按分）
・ターゲット：時短レシピ（調理時間10〜15分）
・冷蔵庫の余り食材：${stock || "特になし"}
・個別リクエスト：${userRequest}

【出力フォーマット】
※各日付の見出しは必ず「### 日付(曜日)」という形式にしてください。

### ${targetDatesDetailed[0]}
**メニュー名**
・手順をここに書く

(複数日ある場合は同様に繰り返す)

## 🛒 買い物リスト

### 【肉・魚類】
- 食材名

### 【野菜・その他】
- 食材名

### 【調味料】
- 調味料名
※注意：調理手順の中で登場する調味料は、定番のものであっても決して省略せず、使用するすべての調味料の名前を漏れなく1行ずつ箇条書きにしてください。解説や余計な文章は一切不要です。

## ⏳ 翌日に向けた下準備
※複数日の提案がある場合、前日の夜にやっておくと当日の時短になる下準備（肉のタレ漬け込みや野菜のカットなど）を具体的に箇条書きで提案してください。1日のみの指定で翌日の献立がない場合や、特に下準備が不要な場合でも、必ずこの見出しを出力し「※特に不要です」と書いてください。`;
      
      const result = await model.generateContent(prompt); const text = result.response.text();
      if (!text) throw new Error("応答が空でした。");
      setAiResponse(text); setActiveTab('menu');
      await supabase.from('budgets').insert([{ budget_amount: budget, item_name: `AI相談 (${targetDateStr})`, expense_price: 0, stock_items: stock, user_request: userRequest, ai_response: text }]);
      fetchBudgetData();
    } catch (err: any) { setAiResponse(`APIエラー: ${err.message || err}`); }
    setLoading(false);
  };

  const formatMenuContent = (rawText: string) => {
    return rawText.split('\n').filter(l => !l.trim().startsWith('###')).map((line, idx) => {
      const trimmed = line.trim(); if (!trimmed) return <div key={idx} className="h-2"></div>;
      if (trimmed.includes('常備品') || trimmed.includes('想定')) return null;

      if (trimmed.startsWith('**') && trimmed.endsWith('**')) {
        return <div key={idx} className="text-sm font-bold text-cyan-300 mt-3 mb-1 border-l-2 border-cyan-500 pl-2">🍳 {trimmed.replace(/\*\转/g, '').replace(/\*\**/g, '')}</div>;
      }
      if (trimmed.startsWith('・') || trimmed.startsWith('-') || /^\d/.test(trimmed)) {
        const contentOnly = trimmed.replace(/^[\s・\-\d\.]+\s*/, '');
        if (contentOnly.startsWith('(') || contentOnly.startsWith('（')) return null;
        return <div key={idx} className="text-xs text-gray-300 pl-4 py-0.5 bg-zinc-900/40 rounded my-0.5">👉 {contentOnly}</div>;
      }
      return <div key={idx} className="text-xs text-gray-400 pl-2">{trimmed}</div>;
    });
  };

  const renderMonthCalendar = () => {
    const daysInMonth = new Date(selectedYear, selectedMonth, 0).getDate();
    const firstDayIndex = new Date(selectedYear, selectedMonth - 1, 1).getDay(); 
    const blankCellsCount = firstDayIndex === 0 ? 6 : firstDayIndex - 1;

    const gridCells = [];
    for (let b = 0; b < blankCellsCount; b++) {
      gridCells.push(<div key={`blank-${b}`} className="p-1.5 opacity-0 pointer-events-none"></div>);
    }

    for (let d = 1; d <= daysInMonth; d++) {
      const dateObj = new Date(selectedYear, selectedMonth - 1, d);
      const currentDayEng = dateObj.getDay();
      const dayJa = DAY_MAP_ENG_TO_JA[currentDayEng];
      const isSelected = selectedDays.includes(d);
      const hasMenu = history.some(item => item.name.includes(`AI相談`) && item.name.includes(`${selectedYear}年${selectedMonth}月${d}日`));
      
      gridCells.push(
        <button key={d} type="button" onClick={() => handleDaySelect(d)} className={`flex flex-col items-center justify-center p-1.5 rounded-xl border font-mono text-xs transition-all ${isSelected ? 'bg-cyan-600 text-white border-cyan-500 font-bold' : 'bg-zinc-950 text-gray-400 border-zinc-900/50 hover:bg-zinc-900'} relative`}>
          <span className="text-[8px] opacity-60 font-sans">{dayJa}</span>
          <span>{d}</span>
          {hasMenu && <div className="absolute bottom-1 w-1 h-1 bg-cyan-400 rounded-full"></div>}
        </button>
      );
    }

    const dynamicYears = Array.from({ length: 86 }, (_, i) => 2020 + i);

    return (
      <div className="bg-zinc-900/80 p-4 rounded-3xl border border-zinc-800 space-y-3">
        <div className="flex justify-between items-center px-1">
          <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Calendar Target (Mon-Sun)</label>
          <div className="flex gap-2">
            <select value={selectedYear} onChange={(e) => setSelectedYear(parseInt(e.target.value))} className="bg-black border border-zinc-800 rounded-lg text-xs px-2 py-1 text-white font-mono">
              {dynamicYears.map(y => <option key={y} value={y}>{y}年</option>)}
            </select>
            <select value={selectedMonth} onChange={(e) => { setSelectedMonth(parseInt(e.target.value)); setSelectedDays([]); }} className="bg-black border border-zinc-800 rounded-lg text-xs px-2 py-1 text-white font-mono">
              {Array.from({ length: 12 }, (_, i) => i + 1).map(m => <option key={m} value={m}>{m}月</option>)}
            </select>
          </div>
        </div>
        <div className="grid grid-cols-7 gap-1 max-h-[160px] overflow-y-auto pr-1">{gridCells}</div>
        <div className="text-center text-[10px] font-bold text-cyan-400 bg-zinc-950 py-1 rounded-xl border border-zinc-900">
          選択日: {selectedDays.length > 0 ? selectedDays.map(d => `${d}日`).join(', ') : '未選択'}
        </div>
      </div>
    );
  };

  const isViewingHistory = selectedDays.length > 0 && history.some(item => 
    item.name.startsWith('AI相談') && selectedDays.some(d => item.name.includes(`${selectedYear}年${selectedMonth}月${d}日`))
  );

  const dynamicStatsYears = Array.from({ length: 86 }, (_, i) => 2020 + i);

  const formattedSelectedDatesText = selectedDays.length > 0 
    ? selectedDays.map(d => `${selectedMonth}月${d}日`).join(', ') 
    : `${selectedMonth}月の日付`;

  // 🛍️ 買い物リストと下準備テキストを分離して表示するためのヘルパー
  const shoppingRawPart = aiResponse.split(/##\s*🛒\s*買い物リスト/i)[1] || "";
  const [shoppingOnlyText, prepText] = shoppingRawPart.split(/##\s*⏳\s*翌日に向けた下準備/i);

  return (
    <div className="min-h-screen bg-black text-gray-200 p-6 font-sans pb-20">
      <header className="max-w-md mx-auto mb-8 text-center">
        <h1 className="text-4xl font-bold text-cyan-400 tracking-tight italic">BudgetBite <span className="text-xs bg-cyan-900 text-cyan-200 px-2 py-0.5 rounded-full not-italic">AI</span></h1>
      </header>

      <main className="max-w-md mx-auto space-y-6">
        {/* 💳 予算カード */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-[2.5rem] p-8 shadow-2xl text-center">
          <p className="text-xs uppercase tracking-widest text-gray-500 mb-1 font-bold">Remaining Budget</p>
          <div className="text-5xl font-mono text-white my-2 font-bold">¥{budget.toLocaleString()}</div>
          <div className="text-[10px] text-cyan-600 font-bold mt-1">
            {isEditingBaseBudget ? (
               <div className="flex justify-center items-center gap-1">
                 <input type="number" value={inputBaseBudget} onChange={(e)=>setInputBaseBudget(e.target.value)} className="bg-black text-white w-20 text-center border border-zinc-700 rounded py-0.5 text-xs"/>
                 <button type="button" onClick={saveBaseBudget} className="text-green-400 font-bold px-1">[OK]</button>
                 <button type="button" onClick={()=>setIsEditingBaseBudget(false)} className="text-gray-500 px-1">✕</button>
               </div>
            ) : (
               <span className="cursor-pointer" onClick={() => { setIsEditingBaseBudget(true); setInputBaseBudget(baseBudget.toString()); }}>基準予算: ¥{baseBudget.toLocaleString()} ✏️</span>
            )}
          </div>
          
          <div className="mt-3 text-[11px] font-bold px-3 py-1 bg-black/40 border border-zinc-800/80 rounded-full inline-flex items-center gap-1.5">
            <span className={aiRemainingCount > 5 ? "text-cyan-400" : aiRemainingCount > 0 ? "text-orange-400" : "text-red-500"}>
              🤖 本日のAI枠: あと {aiRemainingCount} / 20 回
            </span>
          </div>

          <div className="w-full bg-zinc-800 h-1.5 rounded-full mt-4 overflow-hidden">
            <div className="bg-cyan-500 h-full transition-all" style={{ width: `${Math.max(0, (budget/baseBudget)*100)}%` }}></div>
          </div>
        </div>

        {/* 🛍️ カテゴリ選択・出費入力 */}
        <div className="space-y-2 bg-zinc-900/40 p-4 rounded-3xl border border-zinc-800">
          <div className="flex gap-1 bg-black p-1 rounded-xl border border-zinc-900 mb-1">
            {(['自炊', '外食', '買い食い', '会社の弁当'] as CategoryType[]).map(cat => (
              <button key={cat} type="button" onClick={() => handleCategoryChange(cat)} className={`flex-1 py-1.5 rounded-lg text-[10px] font-bold transition-all ${activeCategory === cat ? 'bg-zinc-800 text-white border border-zinc-700' : 'text-gray-600'}`}>{cat}</button>
            ))}
          </div>
          
          <form onSubmit={addExpense} className="flex gap-2">
            <input type="text" value={itemName} onChange={(e) => setItemName(e.target.value)} placeholder={activeCategory === '会社の弁当' ? "社食弁当" : "メニュー名・店名"} className="flex-1 min-w-0 bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-3 text-white text-sm focus:outline-none" />
            <input type="number" value={activeCategory === '会社の弁当' ? "274" : expense} onChange={(e) => setExpense(e.target.value)} placeholder="金額" disabled={activeCategory === '会社の弁当'} className="w-20 bg-zinc-900 border border-zinc-800 rounded-xl px-2 py-3 text-white text-lg font-mono focus:outline-none text-center disabled:opacity-80 disabled:text-cyan-400" />
            <button className="bg-white text-black px-3 sm:px-5 rounded-xl font-bold text-xs whitespace-nowrap">記録</button>
          </form>

          {/* ⭐️ お気に入り登録・呼び出し */}
          <div className="pt-2 border-t border-zinc-900/60 space-y-2">
            <div className="flex justify-between items-center px-1">
              <p className="text-[9px] font-bold text-gray-500 uppercase tracking-widest">お気に入りから入力</p>
              <button type="button" onClick={addCurrentToFavorites} className="text-[9px] bg-cyan-900/40 border border-cyan-800/60 text-cyan-400 font-bold px-2 py-0.5 rounded-lg hover:bg-cyan-800 transition-all">今の入力を登録 ⭐️</button>
            </div>
            <div className="grid grid-cols-3 gap-1.5">
              {favoriteShops.map((shop) => (
                <div key={shop.id} className="relative group">
                  <button type="button" onClick={() => handleApplyFavorite(shop)} className="w-full bg-zinc-950 border border-zinc-900/80 hover:border-zinc-700 py-2 px-1 rounded-xl text-[10px] text-gray-300 font-bold transition-all truncate text-center pr-4">
                    {shop.label}
                  </button>
                  <button type="button" onClick={(e) => deleteFavoriteShop(shop.id, e)} className="absolute top-1 right-1 text-[8px] text-gray-600 hover:text-red-400 px-0.5">✕</button>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* 📅 カレンダー */}
        {renderMonthCalendar()}

        {/* 🤖 AIプランニング入力フォーム */}
        <div className="bg-zinc-900/40 p-4 rounded-3xl border border-zinc-800 space-y-4">
          <input type="text" value={stock} onChange={(e) => setStock(e.target.value)} placeholder="余っている食材" className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-3 text-white text-sm focus:outline-none" />
          <textarea value={userRequest} onChange={(e) => setUserRequest(e.target.value)} className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-3 text-sm text-white min-h-[80px] resize-none focus:outline-none" />
          <button onClick={askGemini} disabled={loading} className="w-full py-5 bg-gradient-to-r from-cyan-600 to-blue-600 text-white rounded-2xl font-bold shadow-xl disabled:opacity-50">
            {loading ? "Geminiが考え中..." : aiRemainingCount <= 0 ? "本日のAI枠上限です" : `選択した${selectedDays.length}日分の献立を相談する`}
          </button>
        </div>

        {/* 📊 履歴表示 */}
        {history.length > 0 && (
          <div className="bg-zinc-900/30 rounded-2xl p-4 border border-zinc-800 space-y-3">
            <p className="text-[10px] font-bold text-gray-500 uppercase tracking-widest px-1">Recent Activity</p>
            {history.slice(0, 5).map(item => (
              <div key={item.id} className="flex justify-between items-center border-b border-zinc-900 pb-2 last:border-0">
                <div className="flex flex-col"><span className="text-gray-300 text-sm truncate max-w-[200px]">{item.name}</span><span className="text-[9px] text-gray-600 font-mono">{item.date}</span></div>
                <div className="flex items-center gap-3">
                  {editingId === item.id ? (
                    <div className="flex items-center gap-1.5">
                      <input type="number" value={editingPrice} onChange={(e) => setEditingPrice(e.target.value)} className="w-20 bg-zinc-950 border border-cyan-800 px-2 py-1 rounded text-right text-white text-xs" autoFocus />
                      <button onClick={() => updateExpensePrice(item.id)} className="text-xs text-green-400 bg-green-950/40 px-2 py-1 rounded border border-green-900">保存</button>
                    </div>
                  ) : (
                    <>
                      <span className={item.price > 0 ? "text-red-400 font-mono font-bold text-sm" : "text-cyan-400 font-bold text-xs"}>{item.price > 0 ? `-¥${item.price.toLocaleString()}` : "AI"}</span>
                      {item.price > 0 && <button onClick={() => { setEditingId(item.id); setEditingPrice(item.price.toString()); }} className="text-xs">✏️</button>}
                      <button onClick={() => deleteExpense(item.id)} className="text-xs">🗑️</button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* 🍽️ タブ表示領域 */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-3xl p-5 shadow-2xl relative">
          {isViewingHistory && (
            <div className="absolute -top-3 left-6 bg-cyan-950 border border-cyan-600 text-cyan-400 text-[10px] font-bold px-3 py-0.5 rounded-full shadow-lg z-10">
              📁 過去ログ復元中: {selectedDays.map(d => `${d}日`).join(', ') || '選択日'}
            </div>
          )}

          <div className="flex gap-1 mb-4 bg-zinc-950 p-1 rounded-xl border border-zinc-800">
            <button onClick={() => setActiveTab('menu')} className={`flex-1 py-2 rounded-lg font-bold text-[11px] ${activeTab === 'menu' ? 'bg-cyan-600 text-white' : 'text-gray-500'}`}>📅 献立</button>
            <button onClick={() => setActiveTab('shopping')} className={`flex-1 py-2 rounded-lg font-bold text-[11px] ${activeTab === 'shopping' ? 'bg-cyan-600 text-white' : 'text-gray-500'}`}>🛒 買い物＆下準備</button>
            <button onClick={() => setActiveTab('stats')} className={`flex-1 py-2 rounded-lg font-bold text-[11px] ${activeTab === 'stats' ? 'bg-cyan-600 text-white' : 'text-gray-500'}`}>📊 分析</button>
          </div>
          
          <div className="text-gray-300 text-sm max-h-[380px] overflow-y-auto pr-1">
            {activeTab === 'menu' && (
              <div className="space-y-4">
                {aiResponse ? (
                  menuDays.length > 0 ? (
                    <>
                      <div className="flex gap-1 bg-zinc-950 p-1 rounded-lg border border-zinc-800/60 overflow-x-auto">
                        {menuDays.map((md) => (
                          <button key={md.day} onClick={() => setActiveDay(md.day)} className={`px-2.5 py-1.5 rounded-md font-bold text-[11px] whitespace-nowrap flex-1 ${activeDay === md.day ? 'bg-zinc-800 text-cyan-400 border border-cyan-800/50' : 'text-gray-500'}`}>{md.day}</button>
                        ))}
                      </div>
                      <div className="bg-zinc-950/60 border border-zinc-800/60 p-4 rounded-2xl space-y-1">{formatMenuContent(menuDays.find(d => d.day === activeDay)?.content || "")}</div>
                    </>
                  ) : (
                    <div className="whitespace-pre-wrap text-xs">{aiResponse.split(/##\s*🛒\s*買い物リスト/i)[0]}</div>
                  )
                ) : (
                  <div className="text-center py-8 text-xs text-gray-500 italic">
                    {formattedSelectedDatesText} の献立はまだ相談されていません。<br />上のフォームから相談してね！
                  </div>
                )}
              </div>
            )}

            {activeTab === 'shopping' && (
              <div className="space-y-6">
                {aiResponse && shoppingSections.length > 0 ? (
                  <>
                    {shoppingSections.map((sec, secIdx) => {
                      const itemsToBuy = sec.items.filter(item => !item.inStock);
                      if (itemsToBuy.length === 0) return null;
                      
                      return (
                        <div key={secIdx} className="border-b border-zinc-800/50 pb-3 last:border-0">
                          <h4 className="text-xs font-bold text-cyan-500 mb-2">{sec.title}</h4>
                          <div className="grid grid-cols-2 gap-2 text-xs">
                            {sec.items.map((item, itemIdx) => {
                              if (item.inStock) return null;
                              return (
                                <div key={item.id} className="flex gap-1">
                                  <button onClick={() => {
                                    const updated = [...shoppingSections]; 
                                    updated[secIdx].items[itemIdx].checked = !updated[secIdx].items[itemIdx].checked; 
                                    setShoppingSections(updated);
                                  }} className={`flex-1 border rounded-l-lg px-2.5 py-2 text-left flex items-center gap-2 truncate ${item.checked ? 'text-gray-600 line-through bg-zinc-900/20 border-zinc-800' : 'text-gray-300 bg-zinc-950/60 border-zinc-800/40'}`}>
                                    <div className={`w-3.5 h-3.5 rounded flex items-center justify-center border ${item.checked ? 'bg-cyan-900 border-cyan-600' : 'border-zinc-700'}`}>{item.checked && <span className="text-[10px] text-cyan-400">✓</span>}</div>
                                    <span className="truncate">{item.name}</span>
                                  </button>
                                  <button title="冷蔵庫にある" onClick={() => {
                                    const updated = [...shoppingSections];
                                    updated[secIdx].items[itemIdx].inStock = true;
                                    setShoppingSections(updated);
                                  }} className="border border-zinc-800/40 bg-zinc-950/60 hover:bg-cyan-950/40 px-2 rounded-r-lg text-xs text-cyan-600 hover:text-cyan-400 transition-all font-sans font-bold">
                                    ❄️
                                  </button>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}

                    <div className="pt-4 border-t border-zinc-800/80 space-y-2">
                      <h4 className="text-xs font-bold text-green-400 flex items-center gap-1">❄️ 冷蔵庫にあるものリスト</h4>
                      {shoppingSections.some(sec => sec.items.some(item => item.inStock)) ? (
                        <div className="grid grid-cols-2 gap-2 text-xs">
                          {shoppingSections.map((sec, secIdx) => 
                            sec.items.map((item, itemIdx) => {
                              if (!item.inStock) return null;
                              return (
                                <button key={item.id} onClick={() => {
                                  const updated = [...shoppingSections];
                                  updated[secIdx].items[itemIdx].inStock = false;
                                  setShoppingSections(updated);
                                }} className="border border-zinc-800 bg-zinc-900/40 rounded-lg px-2.5 py-2 text-left text-gray-400 line-through flex items-center justify-between gap-1 group hover:border-cyan-800 transition-all">
                                  <span className="truncate opacity-70">【{sec.title.replace(/[【】]/g, '')}】{item.name}</span>
                                  <span className="text-[9px] text-gray-600 group-hover:text-cyan-500 font-bold font-sans">戻す</span>
                                </button>
                              );
                            })
                          )}
                        </div>
                      ) : (
                        <div className="text-[10px] text-gray-600 italic pl-1">冷蔵庫にストックした食材はありません。</div>
                      )}
                    </div>

                    {/* ⏳ 翌日に向けた下準備表示エリア */}
                    <div className="pt-4 border-t border-zinc-800/80 space-y-2">
                      <h4 className="text-xs font-bold text-amber-400 flex items-center gap-1">⏳ 翌日に向けた下準備</h4>
                      <div className="bg-zinc-950/80 border border-zinc-900 p-3 rounded-xl text-xs text-gray-400 whitespace-pre-wrap leading-relaxed">
                        {prepText ? prepText.trim() : "※特に不要、または1日のみの指定です。"}
                      </div>
                    </div>
                  </>
                ) : aiResponse ? (
                  <div className="whitespace-pre-wrap text-xs">{shoppingOnlyText || "リストの読み込みに失敗しました。"}</div>
                ) : (
                  <div className="text-center py-8 text-xs text-gray-500 italic">献立を相談すると、必要な買い物リストと翌日の下準備がここに自動生成されるよ！</div>
                )}
              </div>
            )}

            {/* 📊 分析タブ */}
            {activeTab === 'stats' && (
              <div className="space-y-4 p-2">
                <div className="flex flex-col gap-2 pb-3 border-b border-zinc-800">
                  <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">集計対象の期間</p>
                  
                  <div className="flex gap-1 bg-black p-1 rounded-xl border border-zinc-900 text-[10px]">
                    <button type="button" onClick={() => setStatsPeriod('month')} className={`flex-1 py-1 rounded-lg font-bold transition-all ${statsPeriod === 'month' ? 'bg-zinc-800 text-cyan-400 border border-zinc-700/60' : 'text-gray-600'}`}>指定した年月</button>
                    <button type="button" onClick={() => setStatsPeriod('year')} className={`flex-1 py-1 rounded-lg font-bold transition-all ${statsPeriod === 'year' ? 'bg-zinc-800 text-cyan-400 border border-zinc-700/60' : 'text-gray-600'}`}>指定した年だけ</button>
                    <button type="button" onClick={() => setStatsPeriod('all')} className={`flex-1 py-1 rounded-lg font-bold transition-all ${statsPeriod === 'all' ? 'bg-zinc-800 text-cyan-400 border border-zinc-700/60' : 'text-gray-600'}`}>全期間累計</button>
                  </div>

                  {statsPeriod !== 'all' && (
                    <div className="flex gap-2 mt-1">
                      <select value={statsYear} onChange={(e) => setStatsYear(parseInt(e.target.value))} className="flex-1 bg-black border border-zinc-800 rounded-xl text-xs px-2 py-2 text-white font-mono focus:outline-none">
                        {dynamicStatsYears.map(y => <option key={y} value={y}>{y}年</option>)}
                      </select>
                      
                      {statsPeriod === 'month' && (
                        <select value={statsMonth} onChange={(e) => setStatsMonth(parseInt(e.target.value))} className="flex-1 bg-black border border-zinc-800 rounded-xl text-xs px-2 py-2 text-white font-mono focus:outline-none">
                          {Array.from({ length: 12 }, (_, i) => i + 1).map(m => <option key={m} value={m}>{m}月</option>)}
                        </select>
                      )}
                    </div>
                  )}
                </div>

                {getStats().map(s => (
                  <div key={s.category} className="space-y-1">
                    <div className="flex justify-between text-[10px] font-bold uppercase">
                      <span className={s.category === '外食' || s.category === '買い食い' ? 'text-red-400' : 'text-cyan-400'}>{s.category}</span>
                      <span className="font-mono">¥{s.total.toLocaleString()}</span>
                    </div>
                    <div className="w-full bg-zinc-900 h-1.5 rounded-full overflow-hidden border border-zinc-800">
                      <div className={`h-full transition-all ${s.category === '外食' ? 'bg-red-500' : s.category === '買い食い' ? 'bg-orange-500' : 'bg-green-500'}`} style={{ width: `${Math.min(100, (s.total / 10000) * 100)}%` }}></div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="text-center pt-8"><button onClick={resetData} className="text-zinc-800 text-[10px] uppercase tracking-[0.2em] font-bold">Reset Data</button></div>
      </main>
    </div>
  );
}