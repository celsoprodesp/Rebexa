import { useState, useEffect, useRef } from 'react'
import {
  Mic,
  MicOff,
  Settings,
  Volume2,
  VolumeX,
  AlertCircle,
  Send,
  HelpCircle,
  Bot,
  User,
  Trash2,
  Lock,
  Sparkles,
  RefreshCw
} from 'lucide-react'
import { GoogleGenAI } from '@google/genai'

function App() {
  // --- States ---
  const [apiKey, setApiKey] = useState('')
  const [groqApiKey, setGroqApiKey] = useState('')
  const [showSettings, setShowSettings] = useState(false)
  const [isCompatible, setIsCompatible] = useState(true)
  const [isActive, setIsActive] = useState(false) // Whether assistant is enabled/turned on
  const [status, setStatus] = useState('inactive') // 'inactive' | 'listening_trigger' | 'listening_command' | 'processing' | 'speaking'
  const [chatHistory, setChatHistory] = useState([])
  const [currentText, setCurrentText] = useState('') // Display user spoken text in real-time
  const [apiError, setApiError] = useState('')
  const [voices, setVoices] = useState([])

  // --- Refs for Speech API Synchronization (avoids stale closures) ---
  const recognitionRef = useRef(null)
  const isActiveRef = useRef(false)
  const statusRef = useRef('inactive')
  const speechModeRef = useRef('trigger') // 'trigger' | 'command'
  const commandTextRef = useRef('')
  const utteranceRef = useRef(null)
  const chatEndRef = useRef(null)
  const isWaitingForFirstCommandRef = useRef(false)
  const silenceTimerRef = useRef(null)
  const isSilenceTimerReachedRef = useRef(false)
  const commandBaseRef = useRef('')
  const commandStartTimeRef = useRef(0)

  // Load API Key and verify compatibility on mount
  useEffect(() => {
    const savedKey = localStorage.getItem('gemini_api_key')
    const savedGroqKey = localStorage.getItem('groq_api_key')
    if (savedKey) {
      setApiKey(savedKey)
    } else {
      setShowSettings(true) // Open settings if no key is found
    }
    if (savedGroqKey) {
      setGroqApiKey(savedGroqKey)
    }

    // Check Web Speech API compatibility
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SpeechRecognition || !window.speechSynthesis) {
      setIsCompatible(false)
      setStatus('offline')
    }

    // Load speech synthesis voices
    const loadVoices = () => {
      if (window.speechSynthesis) {
        setVoices(window.speechSynthesis.getVoices())
      }
    }
    loadVoices()
    if (window.speechSynthesis) {
      window.speechSynthesis.onvoiceschanged = loadVoices
    }

    // Clean up speech on unmount
    return () => {
      if (window.speechSynthesis) {
        window.speechSynthesis.cancel()
      }
      if (recognitionRef.current) {
        try {
          recognitionRef.current.stop()
        } catch (e) { }
      }
    }
  }, [])

  // Auto-scroll chat to bottom
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [chatHistory, status])

  // Sync state variables to refs to ensure speech listeners always access fresh values
  useEffect(() => {
    isActiveRef.current = isActive
  }, [isActive])

  useEffect(() => {
    statusRef.current = status
  }, [status])

  // --- Web Audio API Synth Sound ---
  const playSound = (type) => {
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext
      if (!AudioContext) return
      const ctx = new AudioContext()
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.connect(gain)
      gain.connect(ctx.destination)

      if (type === 'trigger') {
        // High-tech ascending dual-tone chirp
        osc.type = 'sine'
        osc.frequency.setValueAtTime(523.25, ctx.currentTime) // C5
        osc.frequency.setValueAtTime(659.25, ctx.currentTime + 0.08) // E5
        gain.gain.setValueAtTime(0.08, ctx.currentTime)
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3)
        osc.start(ctx.currentTime)
        osc.stop(ctx.currentTime + 0.3)
      } else if (type === 'error') {
        // Low buzzer warning tone
        osc.type = 'triangle'
        osc.frequency.setValueAtTime(180, ctx.currentTime)
        gain.gain.setValueAtTime(0.12, ctx.currentTime)
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25)
        osc.start(ctx.currentTime)
        osc.stop(ctx.currentTime + 0.25)
      } else if (type === 'off') {
        // Soft descending chirp
        osc.type = 'sine'
        osc.frequency.setValueAtTime(440, ctx.currentTime) // A4
        osc.frequency.setValueAtTime(349.23, ctx.currentTime + 0.08) // F4
        gain.gain.setValueAtTime(0.08, ctx.currentTime)
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3)
        osc.start(ctx.currentTime)
        osc.stop(ctx.currentTime + 0.3)
      }
    } catch (e) {
      console.warn('Audio synthesis failed', e)
    }
  }

  // --- Initialize & Start Speech Recognition ---
  const startAssistant = () => {
    if (!isCompatible) return
    if (!apiKey) {
      setApiError('Por favor, configure uma Gemini API Key antes de ativar.')
      setShowSettings(true)
      playSound('error')
      return
    }

    setApiError('')
    setIsActive(true)
    speechModeRef.current = 'trigger'
    isWaitingForFirstCommandRef.current = false
    setStatus('listening_trigger')

    // Cancel any active speech synthesis
    window.speechSynthesis.cancel()

    // Initialize Speech Recognition
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition
    const rec = new SpeechRecognition()
    rec.continuous = true
    rec.interimResults = true
    rec.lang = 'pt-BR'

    rec.onstart = () => {
      console.log('Speech recognition started in mode:', speechModeRef.current)
    }

    rec.onresult = (event) => {
      const resultIndex = event.resultIndex
      const transcript = event.results[resultIndex][0].transcript.trim()
      const isFinal = event.results[resultIndex].isFinal
      console.log(`Speech heard (${speechModeRef.current}):`, transcript, isFinal ? '(final)' : '(interim)')

      if (speechModeRef.current === 'trigger') {
        // Look for activation words (rebexa, etc.)
        const cleanTranscript = transcript.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        if (
          cleanTranscript.includes('rebeca')
        ) {
          console.log('Trigger keyword detected!')
          playSound('trigger')

          // Switch to command mode
          speechModeRef.current = 'command'
          isWaitingForFirstCommandRef.current = true
          commandTextRef.current = ''
          commandBaseRef.current = ''
          isSilenceTimerReachedRef.current = false
          commandStartTimeRef.current = Date.now()
          setCurrentText('')
          setStatus('listening_command')

          // Stop trigger mode recognition to clear speech buffer
          // and start a fresh session for the command
          rec.stop()
        }
      } else if (speechModeRef.current === 'command') {
        // Avoid processing residual results from the trigger session
        if (isWaitingForFirstCommandRef.current) return

        // Accumulate transcriptions instead of stopping on the first final result
        let finalTranscripts = ''
        let interimTranscripts = ''
        for (let i = 0; i < event.results.length; i++) {
          if (event.results[i].isFinal) {
            finalTranscripts += event.results[i][0].transcript + ' '
          } else {
            interimTranscripts += event.results[i][0].transcript + ' '
          }
        }

        const base = commandBaseRef.current
        const combinedText = base + finalTranscripts + interimTranscripts
        setCurrentText(combinedText.trim())

        const newTotalFinal = base + finalTranscripts
        commandTextRef.current = newTotalFinal.trim() || combinedText.trim()

        // Debounce: Wait 3 seconds of silence before finalizing
        if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current)
        silenceTimerRef.current = setTimeout(() => {
          if (speechModeRef.current === 'command' && commandTextRef.current.trim()) {
            console.log('Silence detected over 3s, stopping to process...')
            isSilenceTimerReachedRef.current = true
            if (recognitionRef.current) {
              try { recognitionRef.current.stop() } catch (e) { }
            }
          }
        }, 3000)
      }
    }

    rec.onerror = (event) => {
      console.error('Speech recognition error:', event.error)
      if (event.error === 'not-allowed') {
        setApiError('Acesso ao microfone negado. Por favor, permita o acesso nas configurações do navegador.')
        stopAssistant()
      }
    }

    rec.onend = () => {
      console.log('Speech recognition ended. Mode was:', speechModeRef.current)

      // If assistant was manually turned off, do nothing
      if (!isActiveRef.current) {
        return
      }

      // Check current mode to determine next action
      if (speechModeRef.current === 'command') {
        if (isWaitingForFirstCommandRef.current) {
          // We just transitioned to command mode, we need to START the actual session for the command
          console.log('Command session starting...')
          isWaitingForFirstCommandRef.current = false
          isSilenceTimerReachedRef.current = false
          setTimeout(() => {
            if (isActiveRef.current) {
              try { rec.start() } catch (e) { }
            }
          }, 100)
        } else if (!isSilenceTimerReachedRef.current && commandTextRef.current.trim() !== '') {
          // Ended early due to aggressive browser timeout but user didn't pause for 3s. Restart engine!
          console.log('Engine timeout before 3s... Restarting background engine!')
          const currentCommand = commandTextRef.current
          commandBaseRef.current = currentCommand + (currentCommand.endsWith(' ') ? '' : ' ')
          setTimeout(() => {
            if (isActiveRef.current) {
              try { rec.start() } catch (e) { }
            }
          }, 100)
        } else if (commandTextRef.current.trim()) {
          // If we have a captured command and 3 seconds passed, send to Gemini
          if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current)
          const userMessage = commandTextRef.current
          // Add user message immediately to the UI chat
          setChatHistory(prev => [...prev, { role: 'user', text: userMessage }])
          setStatus('processing')
          processCommand(userMessage)
        } else {
          // No command detected yet.
          // Check if we are still within the 2-second grace period to start speaking
          if (Date.now() - commandStartTimeRef.current < 2000) {
            console.log('Engine timeout on empty session, but still within 10s grace period. Restarting command session...')
            setTimeout(() => {
              if (isActiveRef.current) {
                try { rec.start() } catch (e) { }
              }
            }, 100)
          } else {
            console.log('No command detected and grace period expired. Returning to trigger mode...')
            speechModeRef.current = 'trigger'
            setStatus('listening_trigger')

            setTimeout(() => {
              if (isActiveRef.current) {
                try { rec.start() } catch (e) { }
              }
            }, 100)
          }
        }
      } else {
        // If in trigger mode and it ended naturally, restart it to maintain continuous listening
        setTimeout(() => {
          if (isActiveRef.current && statusRef.current === 'listening_trigger') {
            try { rec.start() } catch (e) { }
          }
        }, 150)
      }
    }

    recognitionRef.current = rec

    // Start listening
    try {
      rec.start()
    } catch (e) {
      console.error('Failed to start speech recognition:', e)
    }
  }

  // --- Stop Voice Assistant ---
  const stopAssistant = () => {
    setIsActive(false)
    setStatus('inactive')
    playSound('off')
    setCurrentText('')

    if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current)

    // Cancel speaking
    if (window.speechSynthesis) {
      window.speechSynthesis.cancel()
    }

    // Stop recognition
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop()
      } catch (e) { }
    }
  }

  // --- Process User Command via Gemini API ---
  const processCommand = async (command) => {
    const activeGeminiKey = localStorage.getItem('gemini_api_key') || apiKey;
    const activeGroqKey = localStorage.getItem('groq_api_key') || groqApiKey;

    if (!activeGeminiKey) {
      setApiError('Gemini API Key não configurada.')
      stopAssistant()
      return
    }

    try {
      const ai = new GoogleGenAI({ apiKey: activeGeminiKey })

      const groundingTool = {
        googleSearch: {},
      };

      const config = {
        systemInstruction: 'Você é um assistente de voz amigável e prestativo. Suas respostas serão lidas em voz alta por síntese de voz, então seja conciso (máximo de 2 a 3 frases) e evite formatação Markdown como asteriscos, hashtags ou tabelas.',
        tools: [groundingTool],
      };

      const response = await ai.models.generateContent({
        model: 'gemini-flash-lite-latest',
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: command,
              },
            ],
          }
        ],
        //config,
      })
      const replyText = response.text

      // Add response to chat
      setChatHistory(prev => [...prev, { role: 'model', text: replyText }])

      // Read aloud
      speakResponse(replyText)

    } catch (err) {
      console.error('Gemini API Error:', err)

      // Fallback silencioso para o Groq
      if (activeGroqKey) {
        try {
          const groqResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${activeGroqKey}`
            },
            body: JSON.stringify({
              model: 'llama-3.1-8b-instant',
              messages: [
                { role: 'system', content: 'Você é um assistente de voz amigável e prestativo. Suas respostas serão lidas em voz alta.' },
                { role: 'user', content: command }
              ]
            })
          })

          if (!groqResponse.ok) {
            const errData = await groqResponse.text()
            throw new Error(`Status ${groqResponse.status}: ${errData}`)
          }

          const groqData = await groqResponse.json()
          const replyText = groqData.choices[0].message.content

          setChatHistory(prev => [...prev, { role: 'model', text: replyText }])
          speakResponse(replyText)
          return
        } catch (groqErr) {
          console.error('Groq API Error:', groqErr)
        }
      }

      // Se ambos falharam, apenas fala o erro sem poluir o chat
      speakResponse('Desculpe, ocorreu um erro ao processar sua solicitação.')
    }
  }

  // --- Speech Synthesis (Text to Speech) ---
  const speakResponse = (text) => {
    if (!window.speechSynthesis) return

    window.speechSynthesis.cancel() // Cancel anything currently speaking

    // Stop recognition during speech to prevent feedback loop
    if (recognitionRef.current) {
      try { recognitionRef.current.stop() } catch (e) { }
    }

    setStatus('speaking')

    const utterance = new SpeechSynthesisUtterance(text)
    utteranceRef.current = utterance // Store in ref to prevent garbage collection

    // Select Portuguese Voice
    const ptVoice = voices.find(v => v.lang === 'pt-BR') || voices.find(v => v.lang.startsWith('pt'))
    if (ptVoice) {
      utterance.voice = ptVoice
    }
    utterance.lang = 'pt-BR'
    utterance.rate = 1.05 // Slightly faster for conversational feel

    utterance.onend = () => {
      console.log('Speech synthesis completed.')
      resumeListening()
    }

    utterance.onerror = (e) => {
      console.error('Speech synthesis error:', e)
      resumeListening()
    }

    window.speechSynthesis.speak(utterance)
  }

  // --- Resume Trigger Listening after Speech Ends ---
  const resumeListening = () => {
    if (!isActiveRef.current) {
      setStatus('inactive')
      return
    }

    // Switch back to trigger mode
    speechModeRef.current = 'trigger'
    commandTextRef.current = ''
    setCurrentText('')
    setStatus('listening_trigger')

    // Restart speech recognition
    if (recognitionRef.current) {
      recognitionRef.current.continuous = true
      try {
        recognitionRef.current.start()
      } catch (e) {
        console.warn('Could not restart recognition automatically', e)
      }
    }
  }

  // --- Save API Key ---
  const saveApiKey = (e) => {
    e.preventDefault()
    if (apiKey.trim()) {
      localStorage.setItem('gemini_api_key', apiKey.trim())
      setShowSettings(false)
      setApiError('')
    } else {
      localStorage.removeItem('gemini_api_key')
      setApiError('API Key removida. O assistente não funcionará.')
    }

    if (groqApiKey.trim()) {
      localStorage.setItem('groq_api_key', groqApiKey.trim())
    } else {
      localStorage.removeItem('groq_api_key')
    }
  }

  // --- Clean Chat History ---
  const clearChat = () => {
    setChatHistory([])
  }

  // --- Inline Send Command for Keyboard Fallback ---
  const handleManualSubmit = (e) => {
    e.preventDefault()
    if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current)
    const inputField = e.target.elements.manualCommand
    const message = inputField.value.trim()
    if (!message || status === 'processing' || status === 'speaking') return

    inputField.value = ''
    setChatHistory(prev => [...prev, { role: 'user', text: message }])
    setStatus('processing')

    // Stop recognition while processing manual input
    if (recognitionRef.current) {
      try { recognitionRef.current.stop() } catch (e) { }
    }

    processCommand(message)
  }

  // Voice Assistant UI Status Details
  const getStatusDetails = () => {
    switch (status) {
      case 'listening_trigger':
        return {
          title: 'Rebexa',
          sub: 'Diga "Rebexa" ou comece a falar',
          colorClass: 'text-blue-400',
          btnRing: 'animate-ripple-blue bg-blue-600 shadow-blue-500/50',
          desc: 'Monitorando em segundo plano...'
        }
      case 'listening_command':
        return {
          title: 'Ouvindo...',
          sub: currentText || 'Fale seu comando agora',
          colorClass: 'text-green-400 font-medium',
          btnRing: 'animate-ripple-green bg-green-500 shadow-green-500/50',
          desc: 'Fale sua pergunta ou instrução.'
        }
      case 'processing':
        return {
          title: 'Pensando...',
          sub: 'Consultando a inteligência Gemini',
          colorClass: 'text-yellow-400',
          btnRing: 'animate-ripple-yellow bg-yellow-500 shadow-yellow-500/50',
          desc: 'Aguardando resposta do servidor...'
        }
      case 'speaking':
        return {
          title: 'Respondendo',
          sub: 'Ouvindo resposta sintetizada...',
          colorClass: 'text-pink-400',
          btnRing: 'animate-ripple-pink bg-pink-500 shadow-pink-500/50',
          desc: 'Falas de resposta ativas.'
        }
      case 'offline':
        return {
          title: 'Não Suportado',
          sub: 'Web Speech API indisponível',
          colorClass: 'text-red-400',
          btnRing: 'bg-zinc-800 text-zinc-600',
          desc: 'Tente usar o Google Chrome ou Microsoft Edge.'
        }
      case 'inactive':
      default:
        return {
          title: 'Desativado',
          sub: 'Clique para iniciar o assistente',
          colorClass: 'text-zinc-400',
          btnRing: 'bg-zinc-900 border border-zinc-800 hover:border-zinc-700 text-zinc-300 shadow-black/40',
          desc: 'Pronto para iniciar'
        }
    }
  }

  const details = getStatusDetails()

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col justify-between font-sans selection:bg-purple-500/30 antialiased relative overflow-hidden">

      {/* Background Neon Glows */}
      <div className="absolute top-[-10%] left-[-10%] w-[50%] h-[50%] rounded-full bg-purple-900/10 blur-[120px] pointer-events-none"></div>
      <div className="absolute bottom-[-10%] right-[-10%] w-[50%] h-[50%] rounded-full bg-pink-900/10 blur-[120px] pointer-events-none"></div>

      {/* HEADER */}
      <header className="glass sticky top-0 z-40 px-4 py-3 flex flex-col border-b border-zinc-900 shadow-lg">
        <div className="max-w-5xl w-full mx-auto flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-tr from-purple-600 to-pink-500 flex items-center justify-center shadow-md">
              <Sparkles className="w-4 h-4 text-white animate-pulse" />
            </div>
            <h1 className="font-display font-extrabold text-xl tracking-tight bg-clip-text text-transparent bg-gradient-to-r from-purple-400 via-pink-400 to-pink-500">
              Rebexa
            </h1>
            <span className="text-[10px] bg-purple-500/10 text-purple-400 border border-purple-500/20 rounded-full px-2 py-0.5 font-medium">
              PWA v1.0
            </span>
          </div>

          <div className="flex items-center space-x-2">
            <button
              onClick={() => setShowSettings(!showSettings)}
              className={`p-2 rounded-lg transition-all border ${showSettings
                ? 'bg-purple-950/40 border-purple-800 text-purple-300'
                : 'bg-zinc-900/60 border-zinc-800 text-zinc-400 hover:text-zinc-200'
                }`}
              title="Configurações da API Key"
              aria-label="Abrir Configurações"
            >
              <Settings className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* API KEY DRAWER (GLASS) */}
        {showSettings && (
          <div className="max-w-xl w-full mx-auto mt-3 p-4 rounded-xl glass-card border border-zinc-800/80 shadow-2xl transition-all duration-300">
            <h2 className="font-display text-sm font-semibold text-zinc-200 flex items-center mb-2">
              <Lock className="w-4 h-4 text-purple-400 mr-2" />
              Configuração da API Key
            </h2>
            <p className="text-xs text-zinc-400 mb-3">
              Insira a sua chave de API do Gemini (Principal) e se quiser, a chave do Groq como plano de contingência caso o Gemini caia.
            </p>
            <form onSubmit={saveApiKey} className="flex flex-col gap-3">
              <div className="flex gap-2 w-full">
                <input
                  type="password"
                  placeholder="Gemini API Key (Principal)..."
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  className="bg-zinc-900/90 border border-zinc-800 rounded-lg px-3 py-2 text-xs text-zinc-200 placeholder-zinc-500 focus:outline-none focus:ring-1 focus:ring-purple-500 focus:border-transparent flex-1"
                />
              </div>
              <div className="flex gap-2 w-full">
                <input
                  type="password"
                  placeholder="Groq API Key (Fallback Opcional)..."
                  value={groqApiKey}
                  onChange={(e) => setGroqApiKey(e.target.value)}
                  className="bg-zinc-900/90 border border-zinc-800 rounded-lg px-3 py-2 text-xs text-zinc-200 placeholder-zinc-500 focus:outline-none focus:ring-1 focus:ring-orange-500 focus:border-transparent flex-1"
                />
                <button
                  type="submit"
                  className="bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-500 hover:to-pink-500 text-white text-xs font-semibold px-4 py-2 rounded-lg transition-all duration-200 shadow-md shadow-purple-950/20 active:scale-95 cursor-pointer shrink-0"
                >
                  Salvar
                </button>
              </div>
            </form>
            {(apiKey || groqApiKey) && (
              <p className="text-[10px] text-green-400/90 mt-2 flex items-center">
                ● Chaves Configuradas
              </p>
            )}
          </div>
        )}
      </header>

      {/* MAIN CONTAINER */}
      <main className="flex-1 max-w-4xl w-full mx-auto px-4 py-6 flex flex-col md:flex-row gap-6 items-stretch overflow-hidden">

        {/* LEFT COLUMN: INTERACTIVE VOICE CONTROLLER */}
        <section className="flex-1 flex flex-col items-center justify-center p-6 glass-card rounded-2xl border border-zinc-900 shadow-xl relative min-h-[300px]">

          {/* Error Banner */}
          {apiError && (
            <div className="absolute top-4 left-4 right-4 bg-red-950/40 border border-red-800/60 rounded-xl p-3 flex items-start space-x-2 text-red-200 text-xs">
              <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
              <span>{apiError}</span>
            </div>
          )}

          {/* Central Button & Pulse Rings */}
          <div className="relative flex items-center justify-center my-6">

            {/* Pulsing Visual Wave Rings */}
            {isActive && status !== 'inactive' && (
              <div className="absolute inset-[-20px] rounded-full border border-purple-500/10 animate-ping pointer-events-none"></div>
            )}

            <button
              onClick={isActive ? stopAssistant : startAssistant}
              disabled={!isCompatible}
              className={`w-36 h-36 rounded-full flex flex-col items-center justify-center transition-all duration-500 cursor-pointer select-none relative z-10 ${details.btnRing}`}
              title={isActive ? "Desativar Assistente" : "Ativar Assistente"}
              aria-label="Controle de Voz"
            >
              {status === 'processing' ? (
                <RefreshCw className="w-12 h-12 text-zinc-950 animate-spin" />
              ) : status === 'speaking' ? (
                <div className="flex items-end justify-center space-x-1 h-10 mb-1">
                  <div className="soundwave-bar bg-white"></div>
                  <div className="soundwave-bar bg-white"></div>
                  <div className="soundwave-bar bg-white"></div>
                  <div className="soundwave-bar bg-white"></div>
                  <div className="soundwave-bar bg-white"></div>
                </div>
              ) : isActive ? (
                <Mic className="w-12 h-12 text-white animate-pulse" />
              ) : (
                <MicOff className="w-12 h-12 text-zinc-400" />
              )}
            </button>
          </div>

          {/* Assistant Info / Voice Feedbacks */}
          <div className="text-center mt-4 max-w-sm px-4">
            <h3 className={`font-display text-2xl font-extrabold tracking-tight ${details.colorClass}`}>
              {details.title}
            </h3>
            <p className="text-zinc-300 text-sm mt-1 min-h-[40px] italic">
              {details.sub}
            </p>
            <div className="mt-4 pt-3 border-t border-zinc-900/60 w-full flex items-center justify-center space-x-2 text-[11px] text-zinc-500">
              <span className="inline-block w-2 h-2 rounded-full bg-zinc-700"></span>
              <span>{details.desc}</span>
            </div>
          </div>

          {/* Quick Info Tip */}
          {!isActive && isCompatible && (
            <div className="mt-6 flex items-center space-x-1.5 text-xs text-zinc-500 bg-zinc-900/40 px-3 py-1.5 rounded-full border border-zinc-900">
              <HelpCircle className="w-3.5 h-3.5" />
              <span>Diga "Rebexa" para falar após ativar.</span>
            </div>
          )}
        </section>

        {/* RIGHT COLUMN: CHAT TRANSCRIPT & TEXT FALLBACK */}
        <section className="flex-[1.2] flex flex-col justify-between glass-card rounded-2xl border border-zinc-900 shadow-xl overflow-hidden min-h-[400px]">

          {/* Chat Title bar */}
          <div className="px-4 py-3 border-b border-zinc-900/80 bg-zinc-900/20 flex items-center justify-between shrink-0">
            <div className="flex items-center space-x-2 text-zinc-300 text-xs font-semibold">
              <span>Histórico de Conversa</span>
              <span className="text-[10px] bg-zinc-800 text-zinc-400 px-2 py-0.5 rounded-full">
                {chatHistory.length}
              </span>
            </div>
            {chatHistory.length > 0 && (
              <button
                onClick={clearChat}
                className="text-zinc-500 hover:text-red-400 p-1.5 rounded-lg hover:bg-zinc-900/60 transition-colors"
                title="Limpar Histórico"
                aria-label="Limpar Conversas"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            )}
          </div>

          {/* Chat Messages Log */}
          <div className="flex-1 overflow-y-auto p-4 space-y-4 flex flex-col">
            {chatHistory.length === 0 ? (
              <div className="flex-1 flex flex-col items-center justify-center text-center p-6">
                <div className="w-12 h-12 rounded-full bg-zinc-900 flex items-center justify-center mb-3 border border-zinc-800/50">
                  <Bot className="w-6 h-6 text-zinc-500" />
                </div>
                <p className="text-sm font-semibold text-zinc-400">Sem conversas ainda</p>
                <p className="text-xs text-zinc-500 mt-1 max-w-[240px]">
                  Ative o assistente e fale para ver a transcrição aqui em tempo real.
                </p>
                <div className="mt-4 p-3 bg-zinc-900/30 border border-zinc-800/40 rounded-xl text-left max-w-xs">
                  <span className="text-[10px] text-purple-400 uppercase tracking-wider font-semibold block mb-1">Perguntas sugeridas:</span>
                  <ul className="text-[11px] text-zinc-400 space-y-1.5 italic">
                    <li>"Me conte uma curiosidade sobre o espaço."</li>
                    <li>"Diga uma frase inspiradora."</li>
                    <li>"Qual a receita de pão de queijo rápido?"</li>
                  </ul>
                </div>
              </div>
            ) : (
              chatHistory.map((msg, index) => (
                <div
                  key={index}
                  className={`flex items-start gap-2 max-w-[85%] ${msg.role === 'user' ? 'self-end flex-row-reverse' : 'self-start'
                    }`}
                >
                  <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 border ${msg.role === 'user'
                    ? 'bg-purple-900/30 border-purple-800 text-purple-400'
                    : 'bg-zinc-900 border-zinc-800 text-zinc-400'
                    }`}>
                    {msg.role === 'user' ? <User className="w-3.5 h-3.5" /> : <Bot className="w-3.5 h-3.5" />}
                  </div>

                  <div className={`p-3 rounded-2xl text-xs leading-relaxed shadow-sm ${msg.role === 'user'
                    ? 'bg-purple-600 text-white rounded-tr-none'
                    : 'bg-zinc-900 border border-zinc-800 text-zinc-100 rounded-tl-none'
                    }`}>
                    {msg.text}
                  </div>
                </div>
              ))
            )}

            {/* Spoken/Command interim text feedback */}
            {status === 'listening_command' && currentText && (
              <div className="flex items-start gap-2 max-w-[80%] self-end flex-row-reverse opacity-70">
                <div className="w-7 h-7 rounded-full flex items-center justify-center bg-zinc-900 border border-zinc-800 text-zinc-500 shrink-0">
                  <User className="w-3.5 h-3.5" />
                </div>
                <div className="p-3 bg-zinc-900/40 border border-dashed border-zinc-800 text-zinc-400 rounded-2xl rounded-tr-none text-xs italic">
                  {currentText}...
                </div>
              </div>
            )}

            {/* Spinner indicator when processing */}
            {status === 'processing' && (
              <div className="flex items-start gap-2 max-w-[80%] self-start">
                <div className="w-7 h-7 rounded-full flex items-center justify-center bg-zinc-900 border border-zinc-800 text-purple-500 shrink-0">
                  <Bot className="w-3.5 h-3.5" />
                </div>
                <div className="p-3 bg-zinc-900/40 border border-zinc-800/50 rounded-2xl rounded-tl-none flex items-center space-x-2 text-xs text-zinc-500">
                  <RefreshCw className="w-3 h-3 animate-spin text-purple-400" />
                  <span>Gerando resposta...</span>
                </div>
              </div>
            )}

            <div ref={chatEndRef} />
          </div>

          {/* BOTTOM MANUAL INPUT PANEL (FALLBACK) */}
          <div className="p-3 border-t border-zinc-900/80 bg-zinc-900/10 shrink-0">
            <form onSubmit={handleManualSubmit} className="flex gap-2">
              <input
                type="text"
                name="manualCommand"
                disabled={status === 'processing' || status === 'speaking'}
                placeholder="Ou digite o comando aqui..."
                className="bg-zinc-950 border border-zinc-900 focus:border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-200 placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-purple-500/50 flex-1 disabled:opacity-50"
              />
              <button
                type="submit"
                disabled={status === 'processing' || status === 'speaking'}
                className="bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-zinc-300 hover:text-white p-2 rounded-lg transition-colors active:scale-95 disabled:opacity-50 cursor-pointer"
                title="Enviar Comando por Texto"
                aria-label="Enviar por Texto"
              >
                <Send className="w-4 h-4" />
              </button>
            </form>
          </div>
        </section>

      </main>

      {/* FOOTER */}
      <footer className="py-4 border-t border-zinc-950 bg-zinc-950 text-center text-[10px] text-zinc-600 flex flex-col items-center justify-center space-y-1">
        <div>
          Feito em React + Tailwind CSS v4 + Web Speech API + Gemini AI
        </div>
        <div className="flex items-center space-x-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-green-500"></span>
          <span>Aplicativo PWA instalável no celular</span>
        </div>
      </footer>
    </div>
  )
}

export default App
