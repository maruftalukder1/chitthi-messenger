import React, { useState } from 'react';
import { CPP_PROJECT_FILES, CppFile } from '../data/cppProjectData';
import { Download, Copy, Check, FileCode, Cpu, ShieldCheck, CornerDownLeft } from 'lucide-react';
import JSZip from 'jszip';

interface CppExplorerProps {
  lang: 'bn' | 'en';
}

export const CppExplorer: React.FC<CppExplorerProps> = ({ lang }) => {
  const [selectedFile, setSelectedFile] = useState<CppFile>(CPP_PROJECT_FILES[0]);
  const [copied, setCopied] = useState(false);
  const [activeSubTab, setActiveSubTab] = useState<'source' | 'simulator' | 'guide'>('source');

  // Terminal Simulator State
  const [terminalInput, setTerminalInput] = useState('');
  const [terminalLogs, setTerminalLogs] = useState<string[]>([
    '[INIT] Compiling C++20 Chitthi engine with -O3 -pthread...',
    '[INIT] Build successful: chat_server, chat_client generated.',
    '[SERVER] Socket created: AF_INET, SOCK_STREAM (TCP)',
    '[SERVER] Binding to port 8080... OK',
    '[SERVER] Listening for incoming connections (Backlog: 50)...',
    '[NET] Connected client FD 4 (Tanvir, IP: 127.0.0.1:54210)',
    '[NET] Connected client FD 5 (Sarah, IP: 127.0.0.1:54212)',
    '[INFO] Type /help to see interactive simulation commands.',
  ]);

  const handleCopy = () => {
    navigator.clipboard.writeText(selectedFile.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownloadZip = async () => {
    const zip = new JSZip();
    CPP_PROJECT_FILES.forEach((file) => {
      zip.file(file.name, file.content);
    });

    const blob = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'Chitthi_CPP_Source_Project.zip';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const executeTerminalCommand = (cmd: string) => {
    const trimmed = cmd.trim();
    if (!trimmed) return;

    const newLogs = [...terminalLogs, `$ ${trimmed}`];

    if (trimmed === '/help') {
      newLogs.push('Available commands:');
      newLogs.push('  /users       - List active socket connections');
      newLogs.push('  /send <msg>  - Broadcast text message packet');
      newLogs.push('  /sendimage   - Transmit binary JPEG image frame (412 KB)');
      newLogs.push('  /sendvideo   - Stream chunked MP4 video stream (1.8 MB)');
      newLogs.push('  /sendvoice   - Stream 16-bit PCM voice packet (24 KB)');
      newLogs.push('  /packetdump  - Inspect raw network packet binary hex frames');
      newLogs.push('  /clear       - Clear terminal window');
    } else if (trimmed === '/clear') {
      setTerminalLogs([]);
      return;
    } else if (trimmed === '/users') {
      newLogs.push('[SERVER] Active Connected Sockets:');
      newLogs.push('  -> FD 4: Tanvir (Status: Authenticated, Room: 0, Latency: 0.8ms)');
      newLogs.push('  -> FD 5: Sarah  (Status: Authenticated, Room: 0, Latency: 1.1ms)');
      newLogs.push('  -> FD 6: You    (Status: Authenticated, Room: 0, Latency: 0.2ms)');
    } else if (trimmed.startsWith('/send ')) {
      const msg = trimmed.substring(6);
      newLogs.push(`[TX] Packaging PacketType::MSG_TEXT ("${msg}")...`);
      newLogs.push(`[NET] Broadcasted ${msg.length + 26} bytes to 2 connected peers.`);
    } else if (trimmed === '/sendimage') {
      newLogs.push('[TX] Opening binary image stream: image_payload.png');
      newLogs.push('[TX] Magic: 0x50434854 | Type: MSG_IMAGE (2002) | Size: 421888 bytes');
      newLogs.push('[NET] Transmitted binary payload via TCP socket in 103 chunks.');
    } else if (trimmed === '/sendvideo') {
      newLogs.push('[TX] Opening binary video stream: media_clip.mp4');
      newLogs.push('[TX] Magic: 0x50434854 | Type: MSG_VIDEO_CHUNK (2003) | Size: 1887436 bytes');
      newLogs.push('[NET] Chunked transmission complete. Receiver buffer verified.');
    } else if (trimmed === '/sendvoice') {
      newLogs.push('[TX] Recording 16-bit 44.1kHz mono PCM audio...');
      newLogs.push('[TX] Type: MSG_AUDIO_VOICE (2004) | Raw PCM Size: 24576 bytes');
      newLogs.push('[NET] Streamed voice packet to peers with 4ms latency.');
    } else if (trimmed === '/packetdump') {
      newLogs.push('=== RAW TCP PACKET HEX DUMP (protocol.hpp Header + Payload) ===');
      newLogs.push('00000000: 50 43 48 54 07 D1 00 00  00 1B 00 00 00 64 00 00  |PCHT.........d..|');
      newLogs.push('00000010: 00 00 00 00 68 FD 3E 67  48 65 6C 6C 6F 20 43 2B  |....h.>gHello C+|');
      newLogs.push('00000020: 2B 20 4E 65 74 77 6F 72  6B 21 00 00 00 00 00 00  |+ Network!......|');
      newLogs.push('Header verification: MAGIC_HEADER [OK], CRC [OK], Payload bytes: 27');
    } else {
      newLogs.push(`Command not recognized: ${trimmed}. Type /help for options.`);
    }

    setTerminalLogs(newLogs);
    setTerminalInput('');
  };

  return (
    <div className="flex-1 flex flex-col h-full bg-black overflow-hidden select-none">
      {/* Top Banner / Secondary Navigation */}
      <div className="h-14 border-b border-white/10 bg-white/10 px-4 sm:px-6 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Cpu className="w-5 h-5 text-primary" />
          <span className="text-sm font-bold text-white">
            {lang === 'bn' ? 'C++ মাল্টিমিডিয়া চ্যাট ইঞ্জিন' : 'C++ Multimedia Chat Engine'}
          </span>
          <span className="text-[11px] text-white/60 font-mono hidden md:inline">
            (C++20 · POSIX Sockets · Binary Framing)
          </span>
        </div>

        {/* Sub-tabs & Action */}
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 bg-black p-1 rounded-xl border border-white/10">
            <button
              onClick={() => setActiveSubTab('source')}
              className={`px-3 py-1 text-xs font-medium rounded-lg transition-colors ${
                activeSubTab === 'source' ? 'bg-primary text-white' : 'text-white/60 hover:text-white'
              }`}
            >
              {lang === 'bn' ? 'সোর্স কোড ফাইল' : 'Source Code'}
            </button>
            <button
              onClick={() => setActiveSubTab('simulator')}
              className={`px-3 py-1 text-xs font-medium rounded-lg transition-colors ${
                activeSubTab === 'simulator' ? 'bg-primary text-white' : 'text-white/60 hover:text-white'
              }`}
            >
              {lang === 'bn' ? 'টার্মিনাল সিমুলেটর' : 'Terminal Simulator'}
            </button>
            <button
              onClick={() => setActiveSubTab('guide')}
              className={`px-3 py-1 text-xs font-medium rounded-lg transition-colors ${
                activeSubTab === 'guide' ? 'bg-primary text-white' : 'text-white/60 hover:text-white'
              }`}
            >
              {lang === 'bn' ? 'কম্পাইল গাইড' : 'Build Guide'}
            </button>
          </div>

          <button
            onClick={handleDownloadZip}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-online hover:brightness-110 text-white text-xs font-semibold rounded-xl shadow-md transition-all ml-2"
            title="Download full project as ZIP" aria-label="Download full project as ZIP"
          >
            <Download className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">
              {lang === 'bn' ? 'সম্পূর্ণ প্রজেক্ট ডাউনলোড (ZIP)' : 'Download ZIP'}
            </span>
          </button>
        </div>
      </div>

      {/* Main Content Viewport */}
      {activeSubTab === 'source' && (
        <div className="flex-1 flex overflow-hidden">
          {/* File Explorer Sidebar */}
          <div className="w-64 border-r border-white/10 bg-white/10 flex flex-col shrink-0">
            <div className="p-3 border-b border-white/10 text-[11px] font-semibold text-white/60 uppercase tracking-wider">
              {lang === 'bn' ? 'প্রজেক্ট ফাইলসমূহ' : 'Project Files'}
            </div>
            <div className="p-2 space-y-1 overflow-y-auto flex-1">
              {CPP_PROJECT_FILES.map((file) => (
                <button
                  key={file.name}
                  onClick={() => setSelectedFile(file)}
                  className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-xs font-mono text-left transition-colors ${
                    selectedFile.name === file.name
                      ? 'bg-white/10 text-white border border-white/20'
                      : 'text-white/60 hover:text-white/90 hover:bg-white/10'
                  }`}
                >
                  <FileCode className="w-4 h-4 text-primary shrink-0" />
                  <span className="truncate">{file.name}</span>
                </button>
              ))}
            </div>

            <div className="p-3 border-t border-white/10 bg-black/60 text-[11px] text-white/60">
              <span className="font-semibold text-white/80 block mb-0.5">{selectedFile.name}</span>
              <p className="line-clamp-2 text-white/60">{selectedFile.description}</p>
            </div>
          </div>

          {/* Code Viewer Panel */}
          <div className="flex-1 flex flex-col bg-black overflow-hidden">
            {/* Action Bar */}
            <div className="h-10 border-b border-white/10 bg-white/10 px-4 flex items-center justify-between text-xs">
              <span className="font-mono text-white/60">{selectedFile.name}</span>
              <button
                onClick={handleCopy}
                className="flex items-center gap-1.5 px-2.5 py-1 text-white/80 hover:text-white bg-white/10 hover:bg-white/20 rounded-lg transition-colors"
              >
                {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{copied ? (lang === 'bn' ? 'কপি হয়েছে!' : 'Copied!') : (lang === 'bn' ? 'কোড কপি করুন' : 'Copy Code')}</span>
              </button>
            </div>

            {/* Code Body with Line Numbers */}
            <div className="flex-1 overflow-auto p-4 font-mono text-xs leading-relaxed text-white/80 bg-black">
              <pre className="selection:bg-primary selection:text-white">
                <code>{selectedFile.content}</code>
              </pre>
            </div>
          </div>
        </div>
      )}

      {/* Terminal Simulator View */}
      {activeSubTab === 'simulator' && (
        <div className="flex-1 flex flex-col p-4 sm:p-6 overflow-hidden">
          <div className="flex-1 bg-black/90 border border-white/10 rounded-2xl flex flex-col overflow-hidden shadow-2xl">
            {/* Terminal Window Header */}
            <div className="h-10 bg-white/10 border-b border-white/10 px-4 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full bg-rose-500/80" />
                <div className="w-3 h-3 rounded-full bg-amber-500/80" />
                <div className="w-3 h-3 rounded-full bg-emerald-500/80" />
                <span className="text-xs font-mono text-white/60 ml-2">bash - ./chat_server :8080</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                <span className="text-[11px] font-mono text-emerald-400">Server Online</span>
              </div>
            </div>

            {/* Terminal Output */}
            <div className="flex-1 p-4 font-mono text-xs overflow-y-auto space-y-1.5 text-emerald-400/90 selection:bg-emerald-700 selection:text-black">
              {terminalLogs.map((log, idx) => (
                <div key={idx} className="leading-relaxed">
                  {log}
                </div>
              ))}
            </div>

            {/* Terminal Input Bar */}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                executeTerminalCommand(terminalInput);
              }}
              className="h-12 border-t border-white/10 bg-black px-4 flex items-center gap-2"
            >
              <span className="text-emerald-500 font-mono text-sm">$</span>
              <input
                type="text"
                value={terminalInput}
                onChange={(e) => setTerminalInput(e.target.value)}
                placeholder="Type /help, /send <text>, /sendimage, /sendvideo, /packetdump..."
                className="flex-1 bg-transparent border-0 text-white font-mono text-xs focus:outline-none focus:ring-0 placeholder-white/30"
               aria-label="Terminal command" />
              <button
                type="submit"
                className="p-1.5 text-white/60 hover:text-white rounded-lg hover:bg-white/10"
               aria-label="Run command" >
                <CornerDownLeft className="w-4 h-4" />
              </button>
            </form>
          </div>
        </div>
      )}

      {/* Compilation Guide View */}
      {activeSubTab === 'guide' && (
        <div className="flex-1 overflow-y-auto p-6 max-w-4xl mx-auto space-y-6 text-white/90">
          <div className="border border-white/10 bg-white/10 rounded-2xl p-6 space-y-4">
            <h2 className="text-lg font-bold text-white flex items-center gap-2">
              <ShieldCheck className="w-5 h-5 text-primary" />
              <span>
                {lang === 'bn' ? 'C++ মাল্টিমিডিয়া চ্যাট প্রজেক্ট কম্পাইলেশন গাইড' : 'How to Compile and Run the C++ Project'}
              </span>
            </h2>
            <p className="text-xs sm:text-sm text-white/60 leading-relaxed">
              {lang === 'bn'
                ? 'এই C++ প্রজেক্টটি একদম স্ট্যান্ডার্ড C++20 এবং POSIX Socket লাইব্রেরি ব্যবহার করে তৈরি। এতে কোনো অপ্রয়োজনীয় থার্ড-পার্টি লাইব্রেরি ছাড়াই টেক্সট, ফটো, ভিডিও ক্লিপ এবং ভয়েস অডিও প্যাকেট আদান-প্রদান করা যায়।'
                : 'This C++ project is crafted with modern standard C++20 and POSIX sockets. It transmits text, images, video chunks, and audio voice frames directly over binary TCP frames with zero bloat.'}
            </p>

            <div className="space-y-4 pt-2">
              <div className="bg-black p-4 rounded-xl border border-white/10 font-mono text-xs text-indigo-300">
                <p className="text-white/40 mb-2 font-sans font-semibold text-xs">
                  {lang === 'bn' ? '১. লিনাক্স বা ম্যাকের জন্য (GCC / Clang):' : '1. Linux & macOS (g++ or clang++):'}
                </p>
                <p className="text-emerald-400"># সার্ভার কম্পাইল করুন:</p>
                <p className="text-white mb-2">g++ -std=c++20 server.cpp -lpthread -o chat_server</p>
                <p className="text-emerald-400"># ক্লায়েন্ট কম্পাইল করুন:</p>
                <p className="text-white mb-3">g++ -std=c++20 client.cpp -lpthread -o chat_client</p>
                <p className="text-emerald-400"># সার্ভার ও ক্লায়েন্ট রান করুন:</p>
                <p className="text-white/80">./chat_server 8080</p>
                <p className="text-white/80">./chat_client "Tanvir"</p>
              </div>

              <div className="bg-black p-4 rounded-xl border border-white/10 font-mono text-xs text-indigo-300">
                <p className="text-white/40 mb-2 font-sans font-semibold text-xs">
                  {lang === 'bn' ? '২. উইন্ডোজের জন্য (MinGW / Visual Studio):' : '2. Windows (MinGW or MSVC):'}
                </p>
                <p className="text-white mb-2">g++ -std=c++20 server.cpp -lws2_32 -o chat_server.exe</p>
                <p className="text-white">g++ -std=c++20 client.cpp -lws2_32 -o chat_client.exe</p>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
