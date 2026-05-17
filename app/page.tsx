"use client";
import React, { useState, useEffect } from 'react';
import { GoogleGenerativeAI } from "@google/generative-ai";
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
const supabase = createClient(supabaseUrl, supabaseAnonKey);

interface ShoppingItem { id: string; name: string; checked: boolean; inStock?: boolean; }
interface ShoppingSection { title: string; items: ShoppingItem[]; }
interface MenuDay { day: string; displayDay: string; content: string; prep: string; }
interface HistoryItem { id: string; name: string; price: number; date: string; rawAiResponse?: string; year: number; month: number; rawDateObj: Date; }

type ActiveTabType = 'menu' | 'shopping' | 'prep' | 'stats';
type CategoryType = '自炊' | '外食' | '買い食い' | '会社の弁当' | 'その他';
interface FavoriteShop { id: string; label: string; itemName: string; category: CategoryType; defaultPrice: string; }

const DAY_MAP_ENG_TO_JA: Record<number, string> = { 1: '月', 2: '火', 3: '水', 4: '木', 5: '金', 6: '土', 0: '日' };

export default function BudgetBiteAI() {
  const [baseBudget, setBaseBudget] = useState<number>(25000);
  const [isEditingBaseBudget, setIsEditingBaseBudget] = useState(false);
  const [inputBaseBudget, setInputBaseBudget] = useState("");
  const [budget, setBudget] = useState(25000);
  const [aiRemainingCount, setAiRemainingCount] = useState<number>(20);

  const [itemName, setItemName] = useState("");
  const [expense, setExpense] = useState("");
  const [activeCategory, setActiveCategory] = useState<CategoryType>('自炊');
  const [stock, setStock] = useState(""); 
  const [userRequest, setUserRequest] = useState("平日の夜に時間がなくてもパパッと作れる時短レシピにして！");
  
  const [selectedYear, setSelectedYear] = useState<number>(new Date().getFullYear());
  const [selectedMonth, setSelectedMonth] = useState<number>(new Date().getMonth() + 1);
  const [selectedDays, setSelectedDays] = useState<number[]>([]);

  const [statsPeriod, setStatsPeriod] = useState<'all' | 'year' | 'month'>('month');
  const [statsYear, setStatsYear] = useState<number>(new Date().getFullYear());
  const [statsMonth, setStatsMonth] = useState<number>(new Date().getMonth() + 1);

  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [aiResponse, setAiResponse] = useState("");
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<ActiveTabType>('menu');
  const [shoppingSections, setShoppingSections] = useState<ShoppingSection[]>([]);
  const [menuDays, setMenuDays] = useState<MenuDay[]>([]);
  const [activeDay, setActiveDay] = useState<string>("");
  const [favoriteShops, setFavoriteShops] = useState<FavoriteShop[]>([]);

  // 1. 画面起動時にすべてを復元
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

    // レシピ回答を復元
    const savedAiResponse = localStorage.getItem('budgetbite_ai_response');
    if (savedAiResponse) {
      setAiResponse(savedAiResponse);
    }

    // 献立タブの選択されている日付見出しを復元
    const savedActiveDay = localStorage.getItem('budgetbite_active_day');
    if (savedActiveDay) {
      setActiveDay(savedActiveDay);
    }

    // カレンダーで選ばれていた日付配列を復元
    const savedSelectedDays = localStorage.getItem('budgetbite_selected_days');
    if (savedSelectedDays) {
      setSelectedDays(JSON.parse(savedSelectedDays));
    } else {
      const today = new Date();
      setSelectedDays([today.getDate()]);
      localStorage.setItem('budgetbite_selected_days', JSON.stringify([today.getDate()]));
    }

    fetchBudgetData();
  }, []);

  useEffect(() => { 
    fetchBudgetData(); 
  }, [baseBudget]);

  // レシピデータを永続保存する関数
  const updateAiResponse = (text: string) => {
    setAiResponse(text);
    if (typeof window !== 'undefined') {
      localStorage.setItem('budgetbite_ai_response', text);
    }
  };

  // レシピデータのパース処理
  useEffect(() => {
    if (!aiResponse) {
      setShoppingSections([]); setMenuDays([]); return;
    }
    try {
      const parts = aiResponse.split(/##\s*🛒\s*買い物リスト/i);
      const menuPart = parts[0];
      
      const dayBlocks = menuPart.split(/(?=###\s*(?:\d+年|\d+月|\d+日))/g);
      const parsedDays: MenuDay[] = [];

      dayBlocks.forEach(block => {
        const lines = block.split('\n');
        let headerLine = "";
        
        for (const line of lines) {
          if (line.trim().startsWith('###')) {
            headerLine = line.replace('###', '').trim();
            break;
          }
        }
        
        if (!headerLine || headerLine.includes('下準備')) return; 

        let displayDay = "";
        const dateMatch = headerLine.match(/(\d+)日/);
        if (dateMatch) {
          displayDay = `${dateMatch[1]}日`;
        } else {
          return;
        }

        let contentLines: string[] = [];
        let prepLines: string[] = [];
        let isPrepSection = false;

        lines.forEach(line => {
          const trimmed = line.trim();
          if (trimmed.startsWith('###') && !trimmed.startsWith('####')) return; 

          if (trimmed.includes('下準備') && (trimmed.startsWith('#') || trimmed.startsWith('-') || trimmed.startsWith('・'))) {
            isPrepSection = true;
            return;
          }

          if (isPrepSection) {
            if (trimmed && !trimmed.startsWith('### ')) {
              prepLines.push(line);
            }
          } else {
            contentLines.push(line);
          }
        });

        let finalPrep = prepLines.join('\n').trim();
        if (!finalPrep || finalPrep.includes('不要')) {
          finalPrep = "※特に不要です";
        }

        parsedDays.push({
          day: headerLine,
          displayDay: displayDay.trim(),
          content: contentLines.join('\n').trim(),
          prep: finalPrep
        });
      });

      setMenuDays(parsedDays);
      
      if (parsedDays.length > 0) {
        const savedLocal = typeof window !== 'undefined' ? localStorage.getItem('budgetbite_active_day') : "";
        const currentTarget = activeDay || savedLocal || "";
        const isStillValid = parsedDays.some(d => d.day === currentTarget);
        
        if (isStillValid) {
          if (activeDay !== currentTarget) {
            setActiveDay(currentTarget);
          }
        } else {
          const firstValid = parsedDays.find(d => d.displayDay !== "");
          if (firstValid) {
            setActiveDay(firstValid.day);
            localStorage.setItem('budgetbite_active_day', firstValid.day);
          }
        }
      }

      if (parts.length < 2) { setShoppingSections([]); return; }
      const shoppingText = parts[1];
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
          const isBulletPoint = /^[\s\-\* Caravans \-\*・\d\.]/.test(trimmed);
          
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
    } catch (e) { console.error("Parse Error:", e); }
  }, [aiResponse, activeDay]);

  const handleActiveDayChange = (dayString: string) => {
    setActiveDay(dayString);
    localStorage.setItem('budgetbite_active_day', dayString);
  };

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
    if (!error) { 
      setBudget(25000); 
      updateAiResponse(""); 
      setSelectedDays([]);
      localStorage.removeItem('budgetbite_selected_days');
      setHistory([]); 
      setStock(""); 
      setAiRemainingCount(20); 
    }
  };

  // カレンダー日付選択
  const handleDaySelect = (dayNum: number) => {
    let nextDays: number[] = [];
    if (selectedDays.includes(dayNum)) {
      nextDays = selectedDays.filter(d => d !== dayNum);
    } else {
      nextDays = [...selectedDays, dayNum].sort((a, b) => a - b);
    }
    setSelectedDays(nextDays);
    localStorage.setItem('budgetbite_selected_days', JSON.stringify(nextDays));
  };

  // 過去のドットからレシピ履歴を復元する時、カレンダーの青丸もそこに合わせる
  const handleLoadHistoryRecipe = (rawText: string, targetDay: number) => {
    if (rawText) {
      updateAiResponse(rawText);
      setSelectedDays([targetDay]);
      localStorage.setItem('budgetbite_selected_days', JSON.stringify([targetDay]));
      alert(`${targetDay}日の過去レシピとカレンダーの選択を同期したよ！`);
    }
  };

  // Geminiに相談するメイン処理
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
      
      const prompt = `あなたは優秀な節約料理 of プロです。以下の条件に従って、【指定された日付分だけ】の献立、買い物リスト、速度重視の翌日に向けた下準備を指定のフォーマットで漏れなく作成してください。
選択された日数が1日だけなら1日分、5日なら5日分のみを出力し、指定されていない日付の献立は【絶対に】含めないでください。
出力の最初から最後まで、フォーマット以外の挨拶、解説、応援メッセージなどの雑談は【絶対に】一切含めないでください。

【条件】
・対象日（この日付以外は出力禁止）：${targetDatesDetailed.join(', ')}
・全体予算：対象日数に応じた現実的な買い出し総額（1日あたり500円程度を目安に按分）
・ターゲット：時短レシピ（調理時間10〜15分）
・冷蔵庫の余り食材：${stock || "特になし"}
・個別リクエスト：${userRequest}

【出力フォーマット】
※各日付の見出しは必ず「### 日付(曜日)」という形式にし、その日のレシピ手順の直後に、必ず「#### ⏳ この日の夜にやる翌日への下準備」という見出しを作って、その日に行うべき下準備を1日分だけ箇取りで書いてください。
※複数日選択されている場合は、各日付ごとにこのセットを繰り返してください。翌日の調理が特になく下準備が不要な場合は「※特に不要です」と書いてください。

### ${targetDatesDetailed[0]}
**メニュー名**
・手順をここに書く

#### ⏳ この日の夜にやる翌日への下準備
- ここにこの日の夜に仕込む翌日用の下準備を具体的に書く（肉のタレ漬け込み、野菜のまとめ切りなど）

(複数日ある場合は上記セットを日付ごとに繰り返す)

## 🛒 買い物リスト

### 【肉・魚類】
- 食材名

### 【野菜・その他】
- 食材名

### 【調味料】
- 調味料名
※注意：調理手順の中で登場する調味料は、定番のものであっても決して省略せず、使用するすべての調味料の名前を漏れなく1行ずつ箇条書きにしてください。解説や余計な文章は一切不要です。`;
      
      const result = await model.generateContent(prompt); 
      const text = result.response.text();
      if (!text) throw new Error("応答が空でした。");
      
      updateAiResponse(text); 
      localStorage.setItem('budgetbite_selected_days', JSON.stringify(selectedDays));
      
      setActiveTab('menu');
      
      await supabase.from('budgets').insert([{ budget_amount: budget, item_name: `AI相談 (${targetDateStr})`, expense_price: 0, stock_items: stock, user_request: userRequest, ai_response: text }]);
      fetchBudgetData();
    } catch (err: any) { updateAiResponse(`APIエラー: ${err.message || err}`); }
    setLoading(false);
  };

  const formatMenuContent = (rawText: string) => {
    return rawText.split('\n').map((line, idx) => {
      const trimmed = line.trim(); if (!trimmed) return <div key={idx} className="h-2"></div>;
      
      if (trimmed.includes('常備品') || trimmed.includes('想定') || trimmed.includes('下準備')) return null;

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
      
      const matchedHistoryItem = history.find(item => item.name.includes(`AI相談`) && item.name.includes(`${selectedYear}年${selectedMonth}月${d}日`));
      
      gridCells.push(
        <button key={d} type="button" onClick={() => handleDaySelect(d)} className={`flex flex-col items-center justify-center p-1.5 rounded-xl border font-mono text-xs transition-all ${isSelected ? 'bg-cyan-600 text-white border-cyan-500 font-bold' : 'bg-zinc-950 text-gray-400 border-zinc-900/50 hover:bg-zinc-900'} relative`}>
          <span className="text-[8px] opacity-60 font-sans">{dayJa}</span>
          <span>{d}</span>
          {matchedHistoryItem && (
            <div 
              title="過去のレシピを読み込む" 
              onClick={(e) => {
                e.stopPropagation(); 
                if(matchedHistoryItem.rawAiResponse) handleLoadHistoryRecipe(matchedHistoryItem.rawAiResponse, d);
              }}
              className="absolute bottom-1 w-1.5 h-1.5 bg-cyan-400 rounded-full animate-pulse hover:scale-150 transition-all"
            ></div>
          )}
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
            <select value={selectedMonth} onChange={(e) => setSelectedMonth(parseInt(e.target.value))} className="bg-black border border-zinc-800 rounded-lg text-xs px-2 py-1 text-white font-mono">
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

  const dynamicStatsYears = Array.from({ length: 86 }, (_, i) => 2020 + i);
  const shoppingText = aiResponse.split(/##\s*🛒\s*買い物リスト/i)[1] || "";

  const currentActiveDayData = menuDays.find(d => d.day === activeDay);
  const currentPrepText = currentActiveDayData ? currentActiveDayData.prep : "※特に不要です";

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

          {/* ⭐️ お気に入り登録 */}
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
            {loading ? "Geminiが考え中..." : aiRemainingCount <= 0 ? "本日のAI枠上限です" : `選択した日のレシピをAIに相談する`}
          </button>
        </div>

        {/* 🍽️ タブ表示領域 */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-3xl p-5 shadow-2xl relative">
          <div className="flex gap-1 mb-4 bg-zinc-950 p-1 rounded-xl border border-zinc-800">
            <button onClick={() => setActiveTab('menu')} className={`flex-1 py-2 rounded-lg font-bold text-[10px] sm:text-[11px] ${activeTab === 'menu' ? 'bg-cyan-600 text-white' : 'text-gray-500'}`}>📅 献立</button>
            <button onClick={() => setActiveTab('shopping')} className={`flex-1 py-2 rounded-lg font-bold text-[10px] sm:text-[11px] ${activeTab === 'shopping' ? 'bg-cyan-600 text-white' : 'text-gray-500'}`}>🛒 買い物</button>
            <button onClick={() => setActiveTab('prep')} className={`flex-1 py-2 rounded-lg font-bold text-[10px] sm:text-[11px] ${activeTab === 'prep' ? 'bg-cyan-600 text-white' : 'text-gray-500'}`}>⏳ 下準備</button>
            <button onClick={() => setActiveTab('stats')} className={`flex-1 py-2 rounded-lg font-bold text-[10px] sm:text-[11px] ${activeTab === 'stats' ? 'bg-cyan-600 text-white' : 'text-gray-500'}`}>📊 分析</button>
          </div>
          
          <div className="text-gray-300 text-sm max-h-[380px] overflow-y-auto pr-1">
            {/* 1. 📅 献立タブ */}
            {activeTab === 'menu' && (
              <div className="space-y-4">
                {aiResponse ? (
                  menuDays.length > 0 ? (
                    <>
                      <div className="flex gap-1 bg-zinc-950 p-1 rounded-lg border border-zinc-800/60 flex-wrap justify-between">
                        {menuDays.map((md) => {
                          if (!md.displayDay) return null;
                          return (
                            <button key={md.day} onClick={() => handleActiveDayChange(md.day)} className={`px-2 py-1.5 rounded-md font-bold text-[11px] whitespace-nowrap flex-1 text-center min-w-[50px] ${activeDay === md.day ? 'bg-zinc-800 text-cyan-400 border border-cyan-800/50' : 'text-gray-300'}`}>{md.displayDay}</button>
                          );
                        })}
                      </div>
                      <div className="bg-zinc-950/60 border border-zinc-800/60 p-4 rounded-2xl space-y-1">
                        {formatMenuContent(menuDays.find(d => d.day === activeDay)?.content || "")}
                      </div>
                    </>
                  ) : (
                    <div className="whitespace-pre-wrap text-xs">{aiResponse.split(/##\s*🛒\s*買い物リスト/i)[0]}</div>
                  )
                ) : (
                  <div className="text-center py-8 text-xs text-gray-500 italic">
                    現在表示するレシピはありません。<br />カレンダーの青丸ポチを押すか、新しく相談してね！
                  </div>
                )}
              </div>
            )}

            {/* 2. 🛒 買い物タブ */}
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
                  </>
                ) : aiResponse ? (
                  <div className="whitespace-pre-wrap text-xs">{shoppingText || "リストの読み込みに失敗しました。"}</div>
                ) : (
                  <div className="text-center py-8 text-xs text-gray-500 italic">レシピが表示されると、買い物リストが自動生成されるよ！</div>
                )}
              </div>
            )}

            {/* 3. ⏳ 下準備タブ */}
            {activeTab === 'prep' && (
              <div className="space-y-4">
                {aiResponse ? (
                  menuDays.length > 0 ? (
                    <>
                      {/* 上部の日付切り替え横並びボタン（3・4枚目のイメージ通り） */}
                      <div className="flex gap-1 bg-zinc-950 p-1 rounded-lg border border-zinc-800/60 flex-wrap justify-between">
                        {menuDays.map((md) => {
                          if (!md.displayDay) return null;
                          const isCurrentActive = activeDay === md.day;
                          return (
                            <button 
                              key={md.day} 
                              onClick={() => handleActiveDayChange(md.day)} 
                              className={`px-3 py-2 rounded-xl font-bold text-[11px] whitespace-nowrap flex-1 text-center min-w-[50px] transition-all ${
                                isCurrentActive 
                                  ? 'bg-amber-700 text-amber-100 border border-amber-600 font-bold' 
                                  : 'bg-zinc-900/60 text-gray-400 border border-zinc-800/40 hover:bg-zinc-900'
                              }`}
                            >
                              {md.displayDay}
                            </button>
                          );
                        })}
                      </div>

                      {/* 下準備の中身表示カード（スマート表示版） */}
                      <div className="bg-zinc-950/60 border border-zinc-800/60 p-4 rounded-2xl space-y-3">
                        <div className="flex justify-between items-center border-b border-zinc-800 pb-2">
                          <h4 className="text-xs font-bold text-amber-400 flex items-center gap-1">⏳ 翌日に向けた下準備</h4>
                          {currentActiveDayData && (
                            <span className="text-[10px] bg-amber-950/80 border border-amber-900/60 text-amber-400 px-2 py-0.5 rounded-md font-bold font-mono">
                              ({currentActiveDayData.displayDay}の夜に仕込む)
                            </span>
                          )}
                        </div>

                        <div className="text-xs text-gray-300 whitespace-pre-wrap leading-relaxed space-y-1">
                          {currentPrepText.split('\n').map((line, idx) => {
                            const trimmed = line.trim();
                            if (!trimmed) return null;
                            
                            if (trimmed.startsWith('-') || trimmed.startsWith('・')) {
                              return <div key={idx} className="pl-2 py-1 text-gray-200 bg-zinc-900/30 rounded my-0.5 border-l border-amber-600/40">👉 {trimmed.replace(/^[\-・]\s*/, '')}</div>;
                            }
                            if (trimmed.startsWith('#')) return null; 
                            
                            return <div key={idx} className="text-gray-200 py-1 bg-zinc-900/30 rounded my-0.5 border-l border-amber-600/40 pl-2">👉 {trimmed}</div>;
                          })}
                        </div>
                      </div>
                    </>
                  ) : (
                    <div className="text-xs text-gray-400 italic p-4 text-center">下準備データがありません。</div>
                  )
                ) : (
                  <div className="text-center py-8 text-xs text-gray-500 italic">
                    レシピが表示されると、前夜用の下準備がここに自動表示されるよ！
                  </div>
                )}
              </div>
            )}

            {/* 4. 📊 分析タブ */}
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