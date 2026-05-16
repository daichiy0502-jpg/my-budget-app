"use client";
import React, { useState, useEffect } from 'react';
import { GoogleGenerativeAI } from "@google/generative-ai";
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
const supabase = createClient(supabaseUrl, supabaseAnonKey);

interface ShoppingItem { id: string; name: string; checked: boolean; }
interface ShoppingSection { title: string; items: ShoppingItem[]; }
interface MenuDay { day: string; content: string; }
interface HistoryItem { id: string; name: string; price: number; date: string; rawAiResponse?: string; }

type ActiveTabType = 'menu' | 'shopping';
type CookingModeType = '通常' | '時短' | '贅沢';

// 📅 曜日とインデックスの定義
const DAYS_OF_WEEK = ['月', '火', '水', '木', '金', '土', '日'];
const DAY_MAP_ENG_TO_JA: Record<number, string> = { 0: '日', 1: '月', 2: '火', 3: '水', 4: '木', 5: '金', 6: '土' };

export default function BudgetBiteAI() {
  // 💰 予算管理用のステート
  const [baseBudget, setBaseBudget] = useState<number>(25000);
  const [isEditingBaseBudget, setIsEditingBaseBudget] = useState(false);
  const [inputBaseBudget, setInputBaseBudget] = useState("");
  const [budget, setBudget] = useState(25000);

  // 📝 入力フォーム用のステート
  const [itemName, setItemName] = useState("");
  const [expense, setExpense] = useState("");
  const [stock, setStock] = useState(""); 
  const [userRequest, setUserRequest] = useState("平日の夜に時間がなくてもパパッと作れる時短レシピにして！");
  
  // 📅 カレンダー・曜日制御用のステート
  const [selectedDays, setSelectedDays] = useState<string[]>(['月', '火', '水', '木', '金']);
  const [dayModes, setDayModes] = useState<Record<string, CookingModeType>>({
    '月': '通常', '火': '通常', '水': '通常', '木': '通常', '金': '通常', '土': '通常', '日': '通常'
  });
  // 💡 今日の曜日を初期値としてセット（今日優先UX）
  const [activeCalendarDay, setActiveCalendarDay] = useState<string>('月');

  // 🤖 AI応答・パース用のステート
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [aiResponse, setAiResponse] = useState("");
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<ActiveTabType>('menu');
  const [shoppingSections, setShoppingSections] = useState<ShoppingSection[]>([]);
  const [menuDays, setMenuDays] = useState<MenuDay[]>([]);
  
  // 🔧 インライン編集用ステート
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingPrice, setEditingPrice] = useState<string>("");

  // 🌟 初期化処理
  useEffect(() => {
    // 💡 1. 基準予算の復元
    const savedBase = localStorage.getItem('budgetbite_base_budget');
    if (savedBase) {
      const parsed = parseInt(savedBase);
      if (!isNaN(parsed)) setBaseBudget(parsed);
    }

    // 💡 2. 今日優先UX: 現在の実際の曜日を調べてカレンダーの初期選択にする
    const currentDayIndex = new Date().getDay(); // 0が日曜日、1が月曜日...
    const currentJaDay = DAY_MAP_ENG_TO_JA[currentDayIndex];
    setActiveCalendarDay(currentJaDay);

    fetchBudgetData();
  }, []);

  // 基準予算が変わったら残高を再計算
  useEffect(() => {
    fetchBudgetData();
  }, [baseBudget]);

  // AIのテキストが変わるたびに「献立」と「買い物リスト」に自動分解するパースロジック
  useEffect(() => {
    if (!aiResponse) {
      setShoppingSections([]); setMenuDays([]); return;
    }
    try {
      // 📅 1. 献立テキストの曜日分解
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
        const trimmed = line.trim();
        if (!trimmed) { if (currentDayName) currentDayText.push(line); return; }
        const foundDay = dayPatterns.find(p => p.regex.test(trimmed));
        if (foundDay) {
          if (currentDayName && currentDayText.length > 0) {
            parsedDays.push({ day: currentDayName, content: currentDayText.join('\n').trim() });
          }
          currentDayName = foundDay.name; currentDayText = [line]; 
        } else if (currentDayName) { currentDayText.push(line); }
      });
      if (currentDayName && currentDayText.length > 0) {
        parsedDays.push({ day: currentDayName, content: currentDayText.join('\n').trim() });
      }
      setMenuDays(parsedDays);

      // 🛒 2. 買い物リストのパース
      const parts = aiResponse.split(/##\s*🛒\s*買い物リスト/i);
      if (parts.length < 2) { setShoppingSections([]); return; }
      
      const shoppingText = parts[1];
      const lines = shoppingText.split('\n');
      const parsedSections: ShoppingSection[] = [];
      let currentSectionIdx = -1;

      for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
        const line = lines[lineIdx];
        const trimmed = line.trim();
        if (!trimmed) continue;
        
        const isHeader = trimmed.includes('【') && trimmed.includes('】');
        
        if (isHeader) {
          const cleanTitle = trimmed.replace(/###|##|#|\*\*|・|\-|【|】/g, '').trim();
          parsedSections.push({ title: `【${cleanTitle}】`, items: [] });
          currentSectionIdx = parsedSections.length - 1;
        } else if (currentSectionIdx >= 0) {
          const isBulletPoint = /^[\s\-\*・\d\.]/.test(trimmed);
          
          if (isBulletPoint) {
            let itemNameClean = trimmed.replace(/^[\s\-\*・\d\.]+/, '').replace(/\*\*/g, '').trim();
            
            if (itemNameClean.length > 0 && itemNameClean.length < 20) {
              parsedSections[currentSectionIdx].items.push({ 
                id: `item-${currentSectionIdx}-${lineIdx}`, 
                name: itemNameClean, 
                checked: false 
              });
            }
          }
        }
      }
      
      setShoppingSections(parsedSections);
      
    } catch (e) { console.error(e); }
  }, [aiResponse]);

  // 🗄️ Supabaseデータ取得と予算計算
  const fetchBudgetData = async () => {
    try {
      const { data } = await supabase.from('budgets').select('*').order('created_at', { ascending: false });
      if (data) {
        const totalExpense = data.reduce((sum, item) => sum + (item.expense_price || 0), 0);
        
        const currentSavedBase = localStorage.getItem('budgetbite_base_budget');
        const activeBase = currentSavedBase ? parseInt(currentSavedBase) : baseBudget;
        setBudget(activeBase - totalExpense);

        setHistory(data.filter(item => item.expense_price > 0 || item.item_name === "AI相談").map((item): HistoryItem => ({
          id: item.id, 
          name: item.item_name || "買い物", 
          price: item.expense_price,
          rawAiResponse: item.ai_response || undefined,
          date: new Date(item.created_at).toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric' }) + " " + 
                new Date(item.created_at).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })
        })));
        
        const lastAi = data.find(item => item.ai_response);
        if (lastAi && !aiResponse) { 
          setAiResponse(lastAi.ai_response); 
          setStock(lastAi.stock_items || ""); 
          setUserRequest(lastAi.user_request || userRequest); 
        }
      }
    } catch (e) { console.error(e); }
  };

  // 💸 出費の手動追加
  const addExpense = async (e: React.FormEvent) => {
    e.preventDefault(); const price = parseInt(expense); const name = itemName || "買い物";
    if (isNaN(price) || price <= 0) return alert("金額を正しく入力してね！");
    const { error } = await supabase.from('budgets').insert([{ budget_amount: budget - price, item_name: name, expense_price: price, stock_items: stock, user_request: userRequest, ai_response: aiResponse }]);
    if (!error) { setExpense(""); setItemName(""); fetchBudgetData(); }
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

  const resetData = async () => {
    if (!confirm("データをフルリセットする？")) return;
    const { error } = await supabase.from('budgets').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    if (!error) { setAiResponse(""); setHistory([]); setStock(""); fetchBudgetData(); }
  };

  const toggleDay = (day: string) => {
    if (selectedDays.includes(day)) {
      if (selectedDays.length === 1) return alert("最低でも1日は曜日を選んでね！");
      setSelectedDays(selectedDays.filter(d => d !== day));
    } else {
      setSelectedDays([...selectedDays, day]);
    }
  };

  const handleModeChange = (day: string, mode: CookingModeType) => {
    setDayModes(prev => ({ ...prev, [day]: mode }));
  };

  const saveBaseBudget = () => {
    const parsed = parseInt(inputBaseBudget);
    if (isNaN(parsed) || parsed < 0) return alert("正しい予算額を入力してね！");
    setBaseBudget(parsed);
    localStorage.setItem('budgetbite_base_budget', parsed.toString());
    setIsEditingBaseBudget(false);
  };

  // 💡 アイデア1: 「家にある！」ストック自動連携システム
  const toggleShoppingItemWithStockSync = (secIdx: number, itemIdx: number) => {
    const updated = [...shoppingSections];
    const targetItem = updated[secIdx].items[itemIdx];
    
    // チェック状態を反転
    targetItem.checked = !targetItem.checked;
    
    // チェックを入れた（＝購入した・家にある状態になった）場合、上の「余っている食材」に自動追記
    if (targetItem.checked) {
      setStock(prev => {
        const cleanPrev = prev.trim();
        if (!cleanPrev) return targetItem.name;
        // すでに登録されていなければカンマ区切りで追記
        if (cleanPrev.includes(targetItem.name)) return prev;
        return `${cleanPrev}, ${targetItem.name}`;
      });
    } else {
      // チェックを外した場合、ストックから名前を除外する
      setStock(prev => {
        return prev.split(/,\s*/)
          .filter(name => name.trim() !== targetItem.name)
          .join(', ');
      });
    }
    
    setShoppingSections(updated);
  };

  // 💡 アイデア3: 過去プランのワンタップ復元機能
  const restorePastPlan = (rawAiText: string) => {
    if (!rawAiText) return;
    if (confirm("この過去の献立・買い物リストを画面に復元する？")) {
      setAiResponse(rawAiText);
      setActiveTab('menu');
    }
  };

  // 🤖 AIへの相談通信処理
  const askGemini = async () => {
    if (selectedDays.length === 0) return alert("献立を作成する曜日をどれか選んでね！");
    setLoading(true);
    try {
      const genAI = new GoogleGenerativeAI(process.env.NEXT_PUBLIC_GEMINI_API_KEY || "");
      const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
      
      const dayDirectives = selectedDays.map(d => {
        const mode = dayModes[d];
        let directive = "バランスの良い通常メニュー";
        if (mode === '時短') directive = "調理時間10分以内で、爆速かつ超簡単に片付けができる超時短メニュー";
        if (mode === '贅沢') directive = "予算を少し多めに割いて良いので、1週間のご褒美になるような満足感の高い少し贅沢なメニュー";
        return `・${d}曜日：${directive}`;
      }).join('\n');

      const formatDaysPrompt = selectedDays.map(d => `### ${d}曜日\n**メニュー名**\n・手順をここに書く`).join('\n\n');
      
      const prompt = `あなたは優秀な節約料理のプロです。以下の条件に従って、指定された曜日の献立と買い物リストを、指定のフォーマットで漏れなく作成してください。
出力の最初から最後まで、フォーマット以外の挨拶、解説、応援メッセージなどの雑談は【絶対に】一切含めないでください。リストの直後で出力を即座に終了してください。

【条件】
・献立を作成する曜日：${selectedDays.map(d => `${d}曜日`).join(', ')}（※指定されたこれ以外の曜日は出力に含めないでください）

【各曜日の料理モード指定】
${dayDirectives}

・予算：選択された日数と各曜日のモード（贅沢など）を考慮した適切な総額
・冷蔵庫の余り食材：${stock || "特になし"}
・個別リクエスト：${userRequest}

【出力フォーマット】

${formatDaysPrompt}

## 🛒 買い物リスト

### 【肉・魚類】
- 食材名

### 【野菜・その他】
- 食材名

### 【調味料】
- 調味料名
- 調味料名
- 調味料名
※注意：上記の指定された曜日の手順の中で登場する調味料（醤油、酒、みりん、砂糖、塩、片栗粉、油、ポン酢など）は、定番のものであっても決して省略せず、使用するすべての調味料の名前を漏れなく1行ずつ箇取りにしてください。解説や余計な文章は一切不要です。`;
      
      const result = await model.generateContent(prompt); const text = result.response.text();
      if (!text) throw new Error("応答が空でした。");
      setAiResponse(text); setActiveTab('menu');
      await supabase.from('budgets').insert([{ budget_amount: budget, item_name: "AI相談", expense_price: 0, stock_items: stock, user_request: userRequest, ai_response: text }]);
    } catch (err: any) { setAiResponse(`APIエラー: ${err.message || err}`); }
    setLoading(false);
  };

  // 📝 レシピ本文のテキスト装飾マッピング
  const formatMenuContent = (rawText: string) => {
    return rawText.split('\n').filter(l => !l.trim().startsWith('###')).map((line, idx) => {
      const trimmed = line.trim(); if (!trimmed) return <div key={idx} className="h-2"></div>;
      if (trimmed.startsWith('**') && trimmed.endsWith('**')) {
        return <div key={idx} className="text-sm font-bold text-cyan-300 mt-3 mb-1 border-l-2 border-cyan-500 pl-2">🍳 {trimmed.replace(/\*\转/g, '').replace(/\*\*/g, '')}</div>;
      }
      if (trimmed.startsWith('・') || trimmed.startsWith('-') || /^\d/.test(trimmed)) {
        return <div key={idx} className="text-xs text-gray-300 pl-4 py-0.5 bg-zinc-900/40 rounded my-0.5">{trimmed.replace(/^[\s・\-\d\.]+\s*/, '👉 ')}</div>;
      }
      return <div key={idx} className="text-xs text-gray-400 pl-2">{trimmed}</div>;
    });
  };

  return (
    <div className="min-h-screen bg-black text-gray-200 p-6 font-sans pb-20">
      <header className="max-w-md mx-auto mb-8 text-center">
        <h1 className="text-4xl font-bold text-cyan-400 tracking-tight italic">BudgetBite <span className="text-xs bg-cyan-900 text-cyan-200 px-2 py-0.5 rounded-full not-italic">AI</span></h1>
      </header>
      
      <main className="max-w-md mx-auto space-y-6">
        
        {/* 💳 予算カード（上限のインライン設定機能） */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-[2.5rem] p-8 shadow-2xl text-center relative">
          <p className="text-xs uppercase tracking-widest text-gray-500 mb-1 font-bold">Remaining Budget</p>
          <div className="text-5xl font-mono text-white my-2 font-bold">¥{budget.toLocaleString()}</div>
          
          <div className="text-[10px] text-gray-500 font-mono mt-1 flex items-center justify-center gap-1">
            {isEditingBaseBudget ? (
              <div className="flex items-center gap-1 bg-black p-1 rounded border border-zinc-800 z-10">
                <input type="number" value={inputBaseBudget} onChange={(e) => setInputBaseBudget(e.target.value)} className="w-20 bg-zinc-900 text-white text-center rounded border border-zinc-700 font-mono py-0.5 text-xs" autoFocus />
                <button type="button" onClick={saveBaseBudget} className="text-green-400 font-bold px-1 text-[11px]">OK</button>
                <button type="button" onClick={() => setIsEditingBaseBudget(false)} className="text-gray-500 px-1 text-[11px]">✕</button>
              </div>
            ) : (
              <>
                <span>(基準予算: ¥{baseBudget.toLocaleString()})</span>
                <button type="button" onClick={() => { setIsEditingBaseBudget(true); setInputBaseBudget(baseBudget.toString()); }} className="text-cyan-600 hover:text-cyan-400 font-bold text-[11px]">✏️設定</button>
              </>
            )}
          </div>

          <div className="w-full bg-zinc-800 h-1.5 rounded-full mt-4 overflow-hidden">
            <div className="bg-cyan-500 h-full transition-all" style={{ width: `${Math.max(0, (budget/baseBudget)*100)}%` }}></div>
          </div>
        </div>

        {/* 💰 出費手動入力フォーム */}
        <form onSubmit={addExpense} className="space-y-2 bg-zinc-900/40 p-4 rounded-3xl border border-zinc-800">
          <input type="text" value={itemName} onChange={(e) => setItemName(e.target.value)} placeholder="メニュー名・店名" className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-3 text-white text-sm focus:outline-none focus:border-cyan-500" />
          <div className="flex gap-2">
            <input type="number" value={expense} onChange={(e) => setExpense(e.target.value)} placeholder="金額" className="flex-1 bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-3 text-white text-lg font-mono focus:outline-none focus:border-cyan-500" />
            <button className="bg-white text-black px-6 py-3 rounded-xl font-bold">記録</button>
          </div>
        </form>

        {/* 🛠️ 献立プランニング・AIコントロールハブ */}
        <div className="bg-zinc-900/40 p-4 rounded-3xl border border-zinc-800 space-y-4">
          
          {/* 📅 カレンダー・こだわりモード管理エリア */}
          <div className="space-y-3">
            <label className="text-xs font-bold text-gray-400 block">📅 献立の曜日とこだわりモード</label>
            <div className="space-y-2 max-h-[220px] overflow-y-auto pr-1 bg-zinc-950 p-2 rounded-2xl border border-zinc-900">
              {DAYS_OF_WEEK.map(day => {
                const isSelected = selectedDays.includes(day);
                return (
                  <div key={day} className={`flex items-center justify-between p-1.5 rounded-xl border transition-all ${isSelected ? 'bg-zinc-900/60 border-zinc-800' : 'bg-transparent border-transparent opacity-40'}`}>
                    
                    {/* 曜日選択トグルボタン */}
                    <button type="button" onClick={() => toggleDay(day)} className={`px-3 py-1.5 rounded-lg font-bold text-xs ${isSelected ? 'bg-cyan-900 text-cyan-300 border border-cyan-800/40' : 'bg-zinc-900 text-gray-600'}`}>{day}曜</button>
                    
                    {/* 通常・時短・贅沢スライダーボタン */}
                    {isSelected && (
                      <div className="flex gap-0.5 bg-black p-0.5 rounded-lg border border-zinc-800/60">
                        {(['通常', '時短', '贅沢'] as CookingModeType[]).map(mode => (
                          <button key={mode} type="button" onClick={() => handleModeChange(day, mode)} className={`px-2.5 py-1 rounded-md text-[10px] font-bold transition-all ${dayModes[day] === mode ? 'bg-zinc-800 text-white border border-zinc-700/60 shadow-sm' : 'text-gray-600 hover:text-gray-400'}`}>{mode}</button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* 余り物とリクエストの調整 */}
          <div className="space-y-2">
            <label className="text-xs font-bold text-gray-400 block">📥 冷蔵庫のストック状況</label>
            <input type="text" value={stock} onChange={(e) => setStock(e.target.value)} placeholder="余っている食材（買い物チェックで自動追記）" className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-3 text-white text-sm focus:outline-none focus:border-cyan-500" />
          </div>

          <div className="space-y-2">
            <label className="text-xs font-bold text-gray-400 block">💡 AIへの個別リクエスト</label>
            <textarea value={userRequest} onChange={(e) => setUserRequest(e.target.value)} className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-3 text-sm text-white min-h-[80px] resize-none focus:outline-none focus:border-cyan-500" />
          </div>

          <button onClick={askGemini} disabled={loading} className="w-full py-5 bg-gradient-to-r from-cyan-600 to-blue-600 text-white rounded-2xl font-bold shadow-xl disabled:opacity-50">{loading ? "Geminiが考え中..." : "AIコンシェルジュに相談する"}</button>
        </div>

        {/* 🔄 過去の履歴 & プラン復元エリア */}
        {history.length > 0 && (
          <div className="bg-zinc-900/30 rounded-2xl p-4 border border-zinc-800 space-y-3">
            <p className="text-[11px] font-bold text-gray-500 uppercase tracking-wider px-1">📊 最近の履歴・プラン記録</p>
            {history.slice(0, 5).map(item => (
              <div key={item.id} className="flex justify-between items-center border-b border-zinc-900 pb-2 last:border-0">
                <div className="flex flex-col">
                  <span className="text-gray-300 text-sm font-medium">{item.name}</span>
                  <span className="text-[9px] text-gray-600 font-mono">{item.date}</span>
                </div>
                
                <div className="flex items-center gap-3">
                  {/* 💡 アイデア3: 履歴が「AI相談」だった場合、ワンタップで丸ごと復元できるボタンを表示 */}
                  {item.rawAiResponse && (
                    <button onClick={() => restorePastPlan(item.rawAiResponse!)} className="text-xs bg-cyan-950/80 text-cyan-400 px-2 py-1 rounded border border-cyan-900/60 hover:bg-cyan-900 transition-colors">🔄復元</button>
                  )}
                  
                  {item.price > 0 && (
                    <>
                      {editingId === item.id ? (
                        <div className="flex items-center gap-1.5">
                          <input type="number" value={editingPrice} onChange={(e) => setEditingPrice(e.target.value)} className="w-20 bg-zinc-950 border border-cyan-800 px-2 py-1 rounded text-right text-white text-xs" autoFocus />
                          <button onClick={() => updateExpensePrice(item.id)} className="text-xs text-green-400 bg-green-950/40 px-2 py-1 rounded border border-green-900">保存</button>
                        </div>
                      ) : (
                        <>
                          <span className="text-red-400 font-mono font-bold text-sm">-¥{item.price.toLocaleString()}</span>
                          <button onClick={() => { setEditingId(item.id); setEditingPrice(item.price.toString()); }} className="text-xs opacity-60 hover:opacity-100">✏️</button>
                        </>
                      )}
                    </>
                  )}
                  <button onClick={() => deleteExpense(item.id)} className="text-xs opacity-60 hover:opacity-100">🗑️</button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* 🍽️ AI献立・買い物リスト表示用カード */}
        {aiResponse && (
          <div className="bg-zinc-900 border border-zinc-800 rounded-3xl p-5 shadow-2xl">
            {/* メインタブ切り替え */}
            <div className="flex gap-1 mb-4 bg-zinc-950 p-1 rounded-xl border border-zinc-800">
              <button onClick={() => setActiveTab('menu')} className={`flex-1 py-2 rounded-lg font-bold text-[11px] ${activeTab === 'menu' ? 'bg-cyan-600 text-white' : 'text-gray-500'}`}>📅 献立</button>
              <button onClick={() => setActiveTab('shopping')} className={`flex-1 py-2 rounded-lg font-bold text-[11px] ${activeTab === 'shopping' ? 'bg-cyan-600 text-white' : 'text-gray-500'}`}>🛒 買い物リスト</button>
            </div>
            
            <div className="text-gray-300 text-sm max-h-[420px] overflow-y-auto pr-1">
              {activeTab === 'menu' && (
                <div className="space-y-4">
                  {menuDays.length > 0 ? (
                    <>
                      {/* 💡 アイデア4: カレンダー連動型。今日（または選んだ日）の曜日のボタンが自動で光る */}
                      <div className="flex gap-1 bg-zinc-950 p-1 rounded-lg border border-zinc-800/60 overflow-x-auto">
                        {menuDays.map((md) => (
                          <button key={md.day} onClick={() => setActiveCalendarDay(md.day)} className={`px-3 py-1.5 rounded-md font-bold text-xs flex-1 transition-all ${activeCalendarDay === md.day ? 'bg-cyan-950 text-cyan-400 border border-cyan-800/80 shadow' : 'text-gray-500'}`}>{md.day}曜</button>
                        ))}
                      </div>
                      
                      {/* 選択されている曜日の献立手順をフォーマット表示 */}
                      <div className="bg-zinc-950/60 border border-zinc-800/60 p-4 rounded-2xl space-y-1">
                        {formatMenuContent(menuDays.find(d => d.day === activeCalendarDay)?.content || "この曜日の献立はありません。カレンダーから他の曜日を選んでみてね！")}
                      </div>
                    </>
                  ) : (
                    <div className="whitespace-pre-wrap text-xs">{aiResponse.split(/##\s*🛒\s*買い物リスト/i)[0]}</div>
                  )}
                </div>
              )}

              {activeTab === 'shopping' && (
                <div className="space-y-4">
                  {shoppingSections.length > 0 ? (
                    shoppingSections.map((sec, secIdx) => (
                      <div key={secIdx} className="border-b border-zinc-800/50 pb-3 last:border-0">
                        <h4 className="text-xs font-bold text-cyan-500 mb-2">{sec.title}</h4>
                        {sec.items.length > 0 ? (
                          <div className="grid grid-cols-2 gap-2 text-xs">
                            {sec.items.map((item, itemIdx) => (
                              <button key={item.id} onClick={() => toggleShoppingItemWithStockSync(secIdx, itemIdx)} className={`border rounded-lg px-2.5 py-2 text-left flex items-center gap-2 transition-all ${item.checked ? 'text-gray-600 line-through bg-cyan-950/10 border-cyan-950/30' : 'text-gray-300 bg-zinc-950/60 border-zinc-800/40'}`}>
                                <div className={`w-3.5 h-3.5 rounded flex items-center justify-center border transition-all ${item.checked ? 'bg-cyan-900 border-cyan-600' : 'border-zinc-700'}`}>{item.checked && <span className="text-[10px] text-cyan-400">✓</span>}</div>
                                <span className="truncate">{item.name}</span>
                              </button>
                            ))}
                          </div>
                        ) : (
                          <div className="text-xs text-gray-500 italic pl-2">該当する項目がありませんでした。</div>
                        )}
                      </div>
                    ))
                  ) : (
                    <div className="whitespace-pre-wrap text-xs">{aiResponse.split(/##\s*🛒\s*買い物リスト/i)[1] || "リストの読み込みに失敗しました。"}</div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {/* フルリセットボタン */}
        <div className="text-center pt-8">
          <button onClick={resetData} className="text-zinc-800 text-[10px] uppercase tracking-[0.2em] font-bold hover:text-red-900 transition-colors">Reset All Data</button>
        </div>

      </main>
    </div>
  );
}