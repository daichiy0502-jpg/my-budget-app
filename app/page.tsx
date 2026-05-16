"use client";
import React, { useState, useEffect } from 'react';
import { GoogleGenerativeAI } from "@google/generative-ai";
import { createClient } from '@supabase/supabase-js';

// ==========================================
// 1. Supabaseクライアントの初期化
// ==========================================
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
const supabase = createClient(supabaseUrl, supabaseAnonKey);

interface ShoppingItem {
  id: string;
  name: string;
  checked: boolean;
}

interface ShoppingSection {
  title: string;
  items: ShoppingItem[];
}

interface MenuDay {
  day: string;
  content: string;
}

interface HistoryItem {
  id: string;
  name: string;
  price: number;
  date: string;
}

export default function BudgetBiteAI() {
  // 状態管理（ステート）
  const [budget, setBudget] = useState(25000);
  const [itemName, setItemName] = useState("");
  const [expense, setExpense] = useState("");
  const [stock, setStock] = useState(""); 
  const [userRequest, setUserRequest] = useState("1週間3500円程度で、平日の夜に時間がなくてもパパッと作れる時短レシピにして！");
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [aiResponse, setAiResponse] = useState("");
  const [loading, setLoading] = useState(false);
  
  // 表示するメインタブ（'menu' = 献立, 'shopping' = 買い物リスト）
  const [activeTab, setActiveTab] = useState<'menu' | 'shopping'>('menu');

  // 🛒 買い物リストの構造化データ
  const [shoppingSections, setShoppingSections] = useState<ShoppingSection[]>([]);

  // 📅 曜日ごとの献立データと、現在選択されている曜日タブ
  const [menuDays, setMenuDays] = useState<MenuDay[]>([]);
  const [activeDay, setActiveDay] = useState<string>("");
  // 💌 応援メッセージを格納するステート
  const [supportMessage, setSupportMessage] = useState<string>("");

  // ✏️ 履歴の編集用ステート
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingPrice, setEditingPrice] = useState<string>("");

  // Geminiの初期化
  const genAI = new GoogleGenerativeAI(process.env.NEXT_PUBLIC_GEMINI_API_KEY || "");
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

  // 起動時にSupabaseからデータを読み込み
  useEffect(() => {
    fetchBudgetData();
  }, []);

  // AIの回答が更新されたら「曜日ごとの献立」と「買い物リスト」を安全に分解する
  useEffect(() => {
    if (!aiResponse) {
      setShoppingSections([]);
      setMenuDays([]);
      setActiveDay("");
      setSupportMessage("");
      return;
    }

    try {
      // ------------------------------------------
      // 💌 1. 先に応援メッセージを完全に分離・隔離する
      // ------------------------------------------
      let cleanedResponse = aiResponse;
      let extractedMsg = "";
      
      const msgMatch = aiResponse.match(/(だいちゃんへ[^\n]*[\s\S]*|【応援メッセージ】[\s\S]*|応援メッセージ:?[\s\S]*)$/i);
      if (msgMatch) {
        extractedMsg = msgMatch[0].trim();
        cleanedResponse = aiResponse.replace(msgMatch[0], "");
      }

      // ------------------------------------------
      // 📅 2. 献立テキストの曜日分解
      // ------------------------------------------
      const menuPart = cleanedResponse.split(/##\s*🛒\s*買い物リスト/i)[0];
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
        if (!trimmed) {
          if (currentDayName) currentDayText.push(line);
          return;
        }

        const foundDay = dayPatterns.find(p => p.regex.test(trimmed));

        if (foundDay) {
          if (currentDayName && currentDayText.length > 0) {
            parsedDays.push({ day: currentDayName, content: currentDayText.join('\n').trim() });
          }
          currentDayName = foundDay.name;
          currentDayText = [line]; 
        } else {
          if (currentDayName) {
            currentDayText.push(line);
          }
        }
      });
      
      if (currentDayName && currentDayText.length > 0) {
        parsedDays.push({ day: currentDayName, content: currentDayText.join('\n').trim() });
      }

      setMenuDays(parsedDays);
      if (parsedDays.length > 0) {
        setActiveDay(parsedDays[0].day); 
      }

      // ------------------------------------------
      // 🛒 3. 買い物リストのパース（メッセージ混入ガード付き）
      // ------------------------------------------
      const parts = cleanedResponse.split(/##\s*🛒\s*買い物リスト/i);
      if (parts.length < 2) {
        setShoppingSections([]);
        setSupportMessage(extractedMsg);
        return;
      }
      
      const shoppingText = parts[1];
      const lines = shoppingText.split('\n');
      
      const parsedSections: ShoppingSection[] = [];
      let currentSection: ShoppingSection | null = null;
      let stopParsing = false; // メッセージ混入を防ぐフラグ

      for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
        const trimmed = lines[lineIdx].trim();
        if (!trimmed || stopParsing) continue;

        // もし「だいちゃんへ」などの応援メッセージ文脈が始まったら、リストのパースを強制終了
        if (trimmed.startsWith('だいちゃん') || trimmed.includes('応援メッセージ')) {
          stopParsing = true;
          continue;
        }

        // 見出し（### や **【セクション】**）の判定
        const isHeader = trimmed.startsWith('#') || (trimmed.startsWith('**') && trimmed.includes('【'));

        if (isHeader) {
          if (currentSection && currentSection.items.length > 0) {
            parsedSections.push(currentSection);
          }
          const cleanTitle = trimmed.replace(/###|##|#|\*\*|【|】/g, '').trim();
          currentSection = { title: `【${cleanTitle}】`, items: [] };
        } else if (currentSection) {
          // 箇条書き記号（-, *, ・）を綺麗に剥ぎ取る
          let itemNameClean = trimmed.replace(/^[\s\-\*・]+/, '').replace(/\*\*/g, '').trim();
          
          // 「だいちゃんへ」のメッセージが記号なしで始まっていた場合のセーフティガード
          if (itemNameClean.startsWith('だいちゃん') || itemNameClean.startsWith('これ一週間') || itemNameClean.startsWith('仕事で忙しい')) {
            break; 
          }

          if (itemNameClean.length > 0 && itemNameClean.length < 40) {
            currentSection.items.push({
              id: `item-${parsedSections.length}-${lineIdx}`,
              name: itemNameClean,
              checked: false
            });
          }
        }
      }

      // 最後のセクションを回収
      if (currentSection && (currentSection as ShoppingSection).items.length > 0) {
        parsedSections.push(currentSection);
      }

      setShoppingSections(parsedSections);
      setSupportMessage(extractedMsg);

    } catch (parseError) {
      console.error("パースエラー:", parseError);
    }
  }, [aiResponse]);

  // DBからデータ取得＆予算の再計算
  const fetchBudgetData = async () => {
    try {
      const { data, error } = await supabase
        .from('budgets')
        .select('*')
        .order('created_at', { ascending: false });

      if (error) return;

      if (data) {
        const totalExpense = data.reduce((sum, item) => sum + (item.expense_price || 0), 0);
        setBudget(25000 - totalExpense);
        
        const formattedHistory = data
          .filter(item => item.expense_price > 0)
          .map((item): HistoryItem => ({
            id: item.id,
            name: item.item_name || "買い物",
            price: item.expense_price,
            date: new Date(item.created_at).toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric' }) + " " + 
                  new Date(item.created_at).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })
          }));
        setHistory(formattedHistory);

        const lastAiRecord = data.find(item => item.ai_response);
        if (lastAiRecord && !aiResponse) {
          setAiResponse(lastAiRecord.ai_response);
          setStock(lastAiRecord.stock_items || "");
          setUserRequest(lastAiRecord.user_request || userRequest);
        }
      }
    } catch (e) {
      console.error(e);
    }
  };

  // 出費記録
  const addExpense = async (e: React.FormEvent) => {
    e.preventDefault();
    const price = parseInt(expense);
    const name = itemName || "買い物";

    if (isNaN(price) || price <= 0) {
      alert("金額を正しく入力してね！");
      return;
    }

    try {
      const { error } = await supabase
        .from('budgets')
        .insert([{
          budget_amount: budget - price, 
          item_name: name,
          expense_price: price,
          stock_items: stock,
          user_request: userRequest,
          ai_response: aiResponse
        }]);

      if (error) {
        alert("保存に失敗しました: " + error.message);
        return;
      }

      setExpense("");
      setItemName("");
      await fetchBudgetData();

    } catch (err) {
      console.error(err);
    }
  };

  // 金額の更新
  const updateExpensePrice = async (id: string) => {
    const newPrice = parseInt(editingPrice);
    if (isNaN(newPrice) || newPrice < 0) {
      alert("正しい金額を入力してね！");
      return;
    }

    try {
      const { error } = await supabase
        .from('budgets')
        .update({ expense_price: newPrice })
        .eq('id', id);

      if (error) {
        alert("更新に失敗しました");
        return;
      }

      setEditingId(null);
      setEditingPrice("");
      await fetchBudgetData(); 
    } catch (err) {
      console.error(err);
    }
  };

  // 履歴の削除
  const deleteExpense = async (id: string) => {
    if (!confirm("この出費記録を削除してもいい？（予算は自動で戻るよ）")) return;

    try {
      const { error } = await supabase
        .from('budgets')
        .delete()
        .eq('id', id);

      if (error) {
        alert("削除に失敗しました");
        return;
      }

      await fetchBudgetData(); 
    } catch (err) {
      console.error(err);
    }
  };

  // データをフルリセット
  const resetData = async () => {
    if (confirm("データをリセットして予算を¥25,000に戻しますか？")) {
      const { error } = await supabase
        .from('budgets')
        .delete()
        .neq('id', '00000000-0000-0000-0000-000000000000');

      if (error) return;
      setBudget(25000);
      setAiResponse("");
      setHistory([]);
      setStock("");
    }
  };

  // Geminiへ相談
  const askGemini = async () => {
    setLoading(true);
    try {
      const prompt = `あなたは社会人の味方であり、コスパとタイパを極めた節約料理のプロです。
      【1週間分の買い出し金額目安を「3500円程度」】に収めた、効率的な献立を提案してください。
      
      【だいちゃんの状況】
      ・平日は仕事で忙しく、帰宅後に時間をかけずにサクッと作れる「爆速・時短・簡単レシピ（10〜15分）」を求めています。
      ・冷蔵庫の余り：${stock || "特なし"}
      ・リクエスト：「${userRequest}」
      
      【出力の絶対ルール】
      1. 各曜日の献立の見出しは、必ず「### 月曜日」「### 火曜日」のように【曜日名】を明記して開始してください。
      2. 曜日ごとの中身は、まず「**メニュー名**」を書き、その下に「・ステップ1… ・ステップ2…」のように簡単に行を変えて作り方を書いてください。
      3. 買い物リストの始まりには、必ず「## 🛒 買い物リスト」という見出しを書いてください。
      4. 不足食材は「### 【肉・魚類】」「### 【野菜類】」などのカテゴリ別の箇条書き（「- 食材名」形式）で出力してください。
      5. この一週間の献立を作る上で【必要な調味料・常備品】（醤油、みりん、塩、コショウ、油など）は、漏れがないようにすべてリストアップし、必ず「### 【常備しておきたい調味料】」という見出しの下に箇条書き（「- 調味料名」形式）で書き出してください。
      6. 最後に必ず、「だいちゃんへ」から始まる温かい応援メッセージを添えてね。`;
      
      const result = await model.generateContent(prompt);
      const text = result.response.text();
      
      if (!text) throw new Error("Geminiからの応答が空でした。");
      
      setAiResponse(text);
      setActiveTab('menu'); 

      await supabase
        .from('budgets')
        .insert([{
          budget_amount: budget,
          item_name: "AI相談",
          expense_price: 0,
          stock_items: stock,
          user_request: userRequest,
          ai_response: text
        }]);

    } catch (error: any) {
      console.error("Gemini API Error:", error);
      setAiResponse(`エラーが発生しました。APIキーや環境変数の設定を確認してみてね。`);
    }
    setLoading(false);
  };

  const toggleCheck = (sectionIdx: number, itemIdx: number) => {
    const updated = [...shoppingSections];
    updated[sectionIdx].items[itemIdx].checked = !updated[sectionIdx].items[itemIdx].checked;
    setShoppingSections(updated);
  };

  const formatMenuContent = (rawText: string) => {
    const lines = rawText.split('\n').filter(l => !l.trim().startsWith('###'));
    return lines.map((line, idx) => {
      const trimmed = line.trim();
      if (!trimmed) return <div key={idx} className="h-2"></div>;

      if (trimmed.startsWith('**') && trimmed.endsWith('**')) {
        return (
          <div key={idx} className="text-sm font-bold text-cyan-300 mt-3 mb-1 flex items-center gap-1.5 border-l-2 border-cyan-500 pl-2">
            🍳 {trimmed.replace(/\*\*/g, '')}
          </div>
        );
      }
      if (trimmed.startsWith('・') || trimmed.startsWith('-') || /^\d/.test(trimmed)) {
        return (
          <div key={idx} className="text-xs text-gray-300 pl-4 py-0.5 leading-relaxed bg-zinc-900/40 rounded my-0.5">
            {trimmed.replace(/^[\s・\-\d\.]+\s*/, '👉 ')}
          </div>
        );
      }
      return <div key={idx} className="text-xs text-gray-400 pl-2">{trimmed}</div>;
    });
  };

  return (
    <div className="min-h-screen bg-black text-gray-200 p-6 font-sans pb-20">
      <header className="max-w-md mx-auto mb-8 text-center">
        <h1 className="text-4xl font-bold text-cyan-400 tracking-tight italic">BudgetBite <span className="text-xs bg-cyan-900 text-cyan-200 px-2 py-0.5 rounded-full not-italic">AI</span></h1>
        <p className="text-gray-500 mt-2 text-sm uppercase tracking-widest font-light">Efficient Kitchen Management</p>
      </header>

      <main className="max-w-md mx-auto space-y-6">
        {/* 残高表示 */}
        <div className="relative overflow-hidden bg-zinc-900 border border-zinc-800 rounded-[2.5rem] p-8 shadow-2xl">
          <p className="text-xs uppercase tracking-widest text-gray-500 mb-1 font-bold text-center">Remaining Budget</p>
          <div className="text-5xl font-mono text-white my-2 font-bold text-center">¥{budget.toLocaleString()}</div>
          <div className="w-full bg-zinc-800 h-1.5 rounded-full mt-4 overflow-hidden">
            <div className="bg-cyan-500 h-full transition-all duration-1000 ease-out" style={{ width: `${Math.max(0, (budget/25000)*100)}%` }}></div>
          </div>
        </div>

        {/* 記録フォーム */}
        <form onSubmit={addExpense} className="space-y-2 bg-zinc-900/40 p-4 rounded-3xl border border-zinc-800">
          <p className="text-[10px] text-gray-500 px-2 uppercase tracking-widest font-bold">Quick Expense Record</p>
          <input 
            type="text" value={itemName} onChange={(e) => setItemName(e.target.value)}
            placeholder="メニュー名・店名 (例: スーパー、ラーメン)"
            className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-3 text-white text-sm focus:outline-none focus:border-cyan-500 transition-all"
          />
          <div className="flex gap-2">
            <input 
              type="number" value={expense} onChange={(e) => setExpense(e.target.value)}
              placeholder="金額"
              className="flex-1 bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-3 text-white text-lg font-mono focus:outline-none focus:border-cyan-500"
            />
            <button className="bg-white text-black px-6 py-3 rounded-xl font-bold active:scale-95 transition-all shadow-lg">記録</button>
          </div>
        </form>

        {/* AIフォーム */}
        <div className="bg-zinc-900/40 p-4 rounded-3xl border border-zinc-800 space-y-4">
          <p className="text-[10px] text-gray-500 px-2 uppercase tracking-widest font-bold">AI Consultation</p>
          <div className="space-y-1">
            <label className="text-[10px] text-cyan-500 px-2 font-bold uppercase">余っている食材</label>
            <input 
              type="text" value={stock} onChange={(e) => setStock(e.target.value)}
              placeholder="例: たまご、キャベツ、豚肉"
              className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-3 text-white text-sm focus:outline-none focus:border-cyan-500"
            />
          </div>
          <div className="space-y-1">
            <label className="text-[10px] text-cyan-500 px-2 font-bold uppercase">リクエスト内容</label>
            <textarea 
              value={userRequest} onChange={(e) => setUserRequest(e.target.value)}
              className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-cyan-500 min-h-[80px] resize-none"
            />
          </div>
          <button onClick={askGemini} disabled={loading}
            className="w-full py-5 bg-gradient-to-r from-cyan-600 to-blue-600 text-white rounded-2xl font-bold shadow-xl active:scale-95 transition-all disabled:opacity-50"
          >
            {loading ? "Geminiが考え中..." : "AIコンシェルジュに相談する"}
          </button>
        </div>

        {/* 📋 履歴 */}
        {history.length > 0 && (
          <div className="bg-zinc-900/30 rounded-2xl p-4 border border-zinc-800">
            <p className="text-[10px] text-gray-500 px-2 mb-2 uppercase tracking-widest font-bold">Recent History</p>
            <div className="space-y-3">
              {history.slice(0, 5).map(item => (
                <div key={item.id} className="flex justify-between items-center px-2 group border-b border-zinc-900 pb-2 last:border-0 last:pb-0">
                  <div className="flex flex-col flex-1">
                    <span className="text-gray-300 text-sm font-medium">{item.name}</span>
                    <span className="text-[9px] text-gray-600 font-mono">{item.date}</span>
                  </div>
                  
                  <div className="flex items-center gap-3">
                    {editingId === item.id ? (
                      <div className="flex items-center gap-1.5">
                        <input 
                          type="number" value={editingPrice} onChange={(e) => setEditingPrice(e.target.value)}
                          className="w-20 bg-zinc-950 border border-cyan-800 px-2 py-1 rounded text-right font-mono text-white text-xs"
                          autoFocus
                        />
                        <button type="button" onClick={() => updateExpensePrice(item.id)} className="text-xs text-green-400 bg-green-950/40 px-2 py-1 rounded border border-green-900">保存</button>
                        <button type="button" onClick={() => setEditingId(null)} className="text-xs text-gray-500 px-1">✕</button>
                      </div>
                    ) : (
                      <>
                        <span className="text-red-400 font-mono font-bold text-sm">-¥{item.price.toLocaleString()}</span>
                        <div className="flex items-center gap-1">
                          <button type="button" onClick={() => { setEditingId(item.id); setEditingPrice(item.price.toString()); }}
                            className="text-gray-500 hover:text-cyan-400 p-1 text-xs transition-colors" title="金額を変更"
                          >
                            ✏️
                          </button>
                          <button type="button" onClick={() => deleteExpense(item.id)}
                            className="text-gray-500 hover:text-red-400 p-1 text-xs transition-colors" title="削除"
                          >
                            🗑️
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* AI結果表示 */}
        {aiResponse && (
          <div className="bg-zinc-900 border border-cyan-900/30 rounded-3xl p-5 shadow-2xl">
            <div className="text-cyan-400 font-bold mb-3 flex items-center gap-2 border-b border-zinc-800 pb-2">✨ Geminiの提案</div>
            
            {/* メインタブ */}
            <div className="flex gap-2 mb-4 bg-zinc-950 p-1 rounded-xl border border-zinc-800">
              <button type="button" onClick={() => setActiveTab('menu')}
                className={`flex-1 py-2 rounded-lg font-bold text-xs transition-all ${activeTab === 'menu' ? 'bg-cyan-600 text-white shadow' : 'text-gray-500 hover:text-gray-300'}`}
              >
                📅 曜日別の献立
              </button>
              <button type="button" onClick={() => setActiveTab('shopping')}
                className={`flex-1 py-2 rounded-lg font-bold text-xs transition-all ${activeTab === 'shopping' ? 'bg-cyan-600 text-white shadow' : 'text-gray-500 hover:text-gray-300'}`}
              >
                🛒 買い物リスト
              </button>
            </div>

            <div className="text-gray-300 text-sm leading-relaxed max-h-[460px] overflow-y-auto pr-1 font-light">
              {activeTab === 'menu' ? (
                <div className="space-y-4">
                  {menuDays.length > 0 ? (
                    <>
                      <div className="flex justify-between gap-1 bg-zinc-950 p-1 rounded-lg border border-zinc-800/60 overflow-x-auto">
                        {menuDays.map((md) => (
                          <button
                            key={md.day} type="button" onClick={() => setActiveDay(md.day)}
                            className={`px-3 py-1.5 rounded-md font-bold text-xs transition-all flex-1 min-w-[36px] ${
                              activeDay === md.day 
                                ? 'bg-zinc-800 text-cyan-400 border border-cyan-800/50' 
                                : 'text-gray-500 hover:text-gray-300'
                            }`}
                          >
                            {md.day}
                          </button>
                        ))}
                      </div>
                      
                      <div className="bg-zinc-950/60 border border-zinc-800/60 p-4 rounded-2xl space-y-1">
                        {formatMenuContent(menuDays.find(d => d.day === activeDay)?.content || "")}
                      </div>
                    </>
                  ) : (
                    <div className="whitespace-pre-wrap text-xs">
                      {aiResponse.split(/##\s*🛒\s*買い物リスト/i)[0]}
                    </div>
                  )}

                  {supportMessage && (
                    <div className="mt-6 bg-gradient-to-b from-zinc-950 to-zinc-900 border border-dashed border-cyan-900/60 p-4 rounded-2xl text-cyan-300 font-medium whitespace-pre-wrap text-xs leading-relaxed shadow-inner">
                      💡 {supportMessage.replace(/^だいちゃんへ[：:\n]*/i, 'だいちゃんへ：\n')}
                    </div>
                  )}
                </div>
              ) : (
                /* 🛒 買い物リストタブ */
                <div className="space-y-4">
                  {shoppingSections.length > 0 ? (
                    shoppingSections.map((sec, secIdx) => (
                      <div key={secIdx} className="border-b border-zinc-800/50 pb-3 last:border-0">
                        <h4 className="text-xs font-bold text-cyan-500 mb-2">{sec.title}</h4>
                        <div className="grid grid-cols-2 gap-2 text-xs">
                          {sec.items.map((item, itemIdx) => (
                            <button key={item.id} type="button" onClick={() => toggleCheck(secIdx, itemIdx)}
                              className={`border rounded-lg px-2.5 py-2 text-left flex items-center gap-2 transition-all active:scale-95 ${
                                item.checked 
                                  ? 'bg-zinc-900/20 border-zinc-800 text-gray-600 line-through decoration-zinc-700 decoration-1' 
                                  : 'bg-zinc-950/60 border-zinc-800/40 text-gray-300 hover:border-zinc-700'
                              }`}
                            >
                              <div className={`w-3.5 h-3.5 rounded flex items-center justify-center border transition-all flex-shrink-0 ${
                                item.checked ? 'bg-cyan-900 border-cyan-600' : 'border-zinc-700 bg-zinc-900'
                              }`}>
                                {item.checked && <span className="text-[10px] text-cyan-400 font-bold">✓</span>}
                              </div>
                              <span className="truncate">{item.name}</span>
                            </button>
                          ))}
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="whitespace-pre-wrap text-xs">
                      {aiResponse.split(/##\s*🛒\s*買い物リスト/i)[1] || "買い物リストの読み込みに失敗しました。"}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {/* リセット */}
        <div className="text-center pt-8">
          <button onClick={resetData} className="text-zinc-800 text-[10px] hover:text-red-500 transition-colors uppercase tracking-[0.2em] font-bold">
            Reset Data
          </button>
        </div>
      </main>
    </div>
  );
}