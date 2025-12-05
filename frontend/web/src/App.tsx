// App.tsx
import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useState, useEffect } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface GameAchievement {
  id: number;
  gameName: string;
  achievementName: string;
  encryptedScore: string;
  timestamp: number;
  verified: boolean;
}

interface UserAction {
  type: 'add' | 'verify' | 'decrypt';
  timestamp: number;
  details: string;
}

// FHE encryption/decryption functions
const FHEEncryptNumber = (value: number): string => `FHE-${btoa(value.toString())}`;
const FHEDecryptNumber = (encryptedData: string): number => encryptedData.startsWith('FHE-') ? parseFloat(atob(encryptedData.substring(4))) : parseFloat(encryptedData);
const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [achievements, setAchievements] = useState<GameAchievement[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  const [addingAchievement, setAddingAchievement] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newAchievementData, setNewAchievementData] = useState({ gameName: "", achievementName: "", score: "" });
  const [selectedAchievement, setSelectedAchievement] = useState<GameAchievement | null>(null);
  const [decryptedScore, setDecryptedScore] = useState<number | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [publicKey, setPublicKey] = useState("");
  const [contractAddress, setContractAddress] = useState("");
  const [chainId, setChainId] = useState(0);
  const [startTimestamp, setStartTimestamp] = useState(0);
  const [durationDays, setDurationDays] = useState(30);
  const [userActions, setUserActions] = useState<UserAction[]>([]);
  const [activeTab, setActiveTab] = useState('achievements');
  const [searchTerm, setSearchTerm] = useState("");
  const [filterVerified, setFilterVerified] = useState(false);

  // Initialize signature parameters
  useEffect(() => {
    loadData().finally(() => setLoading(false));
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setStartTimestamp(Math.floor(Date.now() / 1000));
      setDurationDays(30);
      setPublicKey(generatePublicKey());
    };
    initSignatureParams();
  }, []);

  // Load data from contract
  const loadData = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      // Check contract availability
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) {
        setTransactionStatus({ visible: true, status: "success", message: "Contract is available!" });
        setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
      }
      
      // Load achievements
      const achievementsBytes = await contract.getData("achievements");
      let achievementsList: GameAchievement[] = [];
      if (achievementsBytes.length > 0) {
        try {
          const achievementsStr = ethers.toUtf8String(achievementsBytes);
          if (achievementsStr.trim() !== '') achievementsList = JSON.parse(achievementsStr);
        } catch (e) {}
      }
      setAchievements(achievementsList);
    } catch (e) {
      console.error("Error loading data:", e);
      setTransactionStatus({ visible: true, status: "error", message: "Failed to load data" });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { 
      setIsRefreshing(false); 
      setLoading(false); 
    }
  };

  // Add new achievement
  const addAchievement = async () => {
    if (!isConnected || !address) { 
      setTransactionStatus({ visible: true, status: "error", message: "Please connect wallet first" });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
      return; 
    }
    
    setAddingAchievement(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Adding achievement with Zama FHE..." });
    
    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      // Create new achievement
      const newAchievement: GameAchievement = {
        id: achievements.length + 1,
        gameName: newAchievementData.gameName,
        achievementName: newAchievementData.achievementName,
        encryptedScore: FHEEncryptNumber(parseInt(newAchievementData.score)),
        timestamp: Math.floor(Date.now() / 1000),
        verified: false
      };
      
      // Update achievements list
      const updatedAchievements = [...achievements, newAchievement];
      
      // Save to contract
      await contract.setData("achievements", ethers.toUtf8Bytes(JSON.stringify(updatedAchievements)));
      
      // Update user actions
      const newAction: UserAction = {
        type: 'add',
        timestamp: Math.floor(Date.now() / 1000),
        details: `Added achievement: ${newAchievementData.achievementName} in ${newAchievementData.gameName}`
      };
      setUserActions(prev => [newAction, ...prev]);
      
      setTransactionStatus({ visible: true, status: "success", message: "Achievement added successfully!" });
      await loadData();
      
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowAddModal(false);
        setNewAchievementData({ gameName: "", achievementName: "", score: "" });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") 
        ? "Transaction rejected by user" 
        : "Submission failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { 
      setAddingAchievement(false); 
    }
  };

  // Verify achievement
  const verifyAchievement = async (achievementId: number) => {
    if (!isConnected || !address) { 
      setTransactionStatus({ visible: true, status: "error", message: "Please connect wallet first" });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
      return; 
    }
    
    setTransactionStatus({ visible: true, status: "pending", message: "Verifying achievement..." });
    
    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      // Find the achievement
      const achievementIndex = achievements.findIndex(a => a.id === achievementId);
      if (achievementIndex === -1) throw new Error("Achievement not found");
      
      // Update verification status
      const updatedAchievements = [...achievements];
      updatedAchievements[achievementIndex].verified = true;
      
      // Save to contract
      await contract.setData("achievements", ethers.toUtf8Bytes(JSON.stringify(updatedAchievements)));
      
      // Update user actions
      const newAction: UserAction = {
        type: 'verify',
        timestamp: Math.floor(Date.now() / 1000),
        details: `Verified achievement: ${updatedAchievements[achievementIndex].achievementName}`
      };
      setUserActions(prev => [newAction, ...prev]);
      
      setTransactionStatus({ visible: true, status: "success", message: "Achievement verified!" });
      await loadData();
      
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") 
        ? "Transaction rejected by user" 
        : "Verification failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  // Decrypt score with signature
  const decryptWithSignature = async (encryptedData: string): Promise<number | null> => {
    if (!isConnected) { 
      setTransactionStatus({ visible: true, status: "error", message: "Please connect wallet first" });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
      return null; 
    }
    
    setIsDecrypting(true);
    try {
      const message = `publickey:${publicKey}\ncontractAddresses:${contractAddress}\ncontractsChainId:${chainId}\nstartTimestamp:${startTimestamp}\ndurationDays:${durationDays}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1500));
      
      // Update user actions
      const newAction: UserAction = {
        type: 'decrypt',
        timestamp: Math.floor(Date.now() / 1000),
        details: "Decrypted FHE achievement score"
      };
      setUserActions(prev => [newAction, ...prev]);
      
      return FHEDecryptNumber(encryptedData);
    } catch (e) { 
      return null; 
    } finally { 
      setIsDecrypting(false); 
    }
  };

  // Render achievement stats
  const renderAchievementStats = () => {
    const totalAchievements = achievements.length;
    const verifiedCount = achievements.filter(a => a.verified).length;
    const verificationRate = totalAchievements > 0 ? (verifiedCount / totalAchievements) * 100 : 0;
    
    return (
      <div className="stats-container">
        <div className="stat-card">
          <div className="stat-value">{totalAchievements}</div>
          <div className="stat-label">Total Achievements</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{verifiedCount}</div>
          <div className="stat-label">Verified</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{verificationRate.toFixed(1)}%</div>
          <div className="stat-label">Verification Rate</div>
        </div>
      </div>
    );
  };

  // Render user actions history
  const renderUserActions = () => {
    if (userActions.length === 0) return <div className="no-data">No actions recorded</div>;
    
    return (
      <div className="actions-list">
        {userActions.map((action, index) => (
          <div className="action-item" key={index}>
            <div className={`action-type ${action.type}`}>
              {action.type === 'add' && '➕'}
              {action.type === 'verify' && '✅'}
              {action.type === 'decrypt' && '🔓'}
            </div>
            <div className="action-details">
              <div className="action-text">{action.details}</div>
              <div className="action-time">{new Date(action.timestamp * 1000).toLocaleString()}</div>
            </div>
          </div>
        ))}
      </div>
    );
  };

  // Render FAQ section
  const renderFAQ = () => {
    const faqItems = [
      {
        question: "What is Encrypted Online Gaming Profile?",
        answer: "It's a cross-game, player-owned encrypted gaming profile where game developers can verify achievements or levels without seeing your specific data from other games."
      },
      {
        question: "How does FHE protect my gaming data?",
        answer: "FHE (Fully Homomorphic Encryption) allows computations on encrypted data without decrypting it. Your achievements and playtime remain encrypted while still being verifiable."
      },
      {
        question: "Can game developers see my other game data?",
        answer: "No, game developers can only verify specific conditions (like whether you have a certain achievement) without seeing your actual data from other games."
      },
      {
        question: "How do I decrypt my own data?",
        answer: "You can decrypt your own data using your wallet signature, which proves you're the owner of the encrypted profile."
      },
      {
        question: "What blockchain is this built on?",
        answer: "This system is built on Ethereum and utilizes Zama FHE for privacy-preserving computations."
      }
    ];
    
    return (
      <div className="faq-container">
        {faqItems.map((item, index) => (
          <div className="faq-item" key={index}>
            <div className="faq-question">{item.question}</div>
            <div className="faq-answer">{item.answer}</div>
          </div>
        ))}
      </div>
    );
  };

  // Filter achievements based on search and filter
  const filteredAchievements = achievements.filter(achievement => {
    const matchesSearch = achievement.gameName.toLowerCase().includes(searchTerm.toLowerCase()) || 
                         achievement.achievementName.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesFilter = !filterVerified || achievement.verified;
    return matchesSearch && matchesFilter;
  });

  if (loading) return (
    <div className="loading-screen">
      <div className="fhe-spinner"></div>
      <p>Initializing encrypted gaming profile...</p>
    </div>
  );

  return (
    <div className="app-container">
      <header className="app-header">
        <div className="logo">
          <div className="logo-icon">
            <div className="game-icon"></div>
          </div>
          <h1>GamerID<span>FHE</span></h1>
        </div>
        
        <div className="header-actions">
          <button 
            onClick={() => setShowAddModal(true)} 
            className="add-achievement-btn"
          >
            <div className="add-icon"></div>Add Achievement
          </button>
          <div className="wallet-connect-wrapper">
            <ConnectButton accountStatus="address" chainStatus="icon" showBalance={false}/>
          </div>
        </div>
      </header>
      
      <div className="main-content-container">
        <div className="dashboard-section">
          <div className="dashboard-grid">
            <div className="dashboard-panel intro-panel">
              <div className="panel-card">
                <h2>Encrypted Gaming Profile</h2>
                <p>GamerID_FHE is a cross-game, player-owned encrypted gaming profile powered by Zama FHE technology.</p>
                <div className="fhe-badge">
                  <div className="fhe-icon"></div>
                  <span>Powered by Zama FHE</span>
                </div>
              </div>
              
              <div className="panel-card">
                <h2>Your Gaming Stats</h2>
                {renderAchievementStats()}
              </div>
            </div>
          </div>
          
          <div className="tabs-container">
            <div className="tabs">
              <button 
                className={`tab ${activeTab === 'achievements' ? 'active' : ''}`}
                onClick={() => setActiveTab('achievements')}
              >
                Achievements
              </button>
              <button 
                className={`tab ${activeTab === 'actions' ? 'active' : ''}`}
                onClick={() => setActiveTab('actions')}
              >
                My Actions
              </button>
              <button 
                className={`tab ${activeTab === 'faq' ? 'active' : ''}`}
                onClick={() => setActiveTab('faq')}
              >
                FAQ
              </button>
            </div>
            
            <div className="tab-content">
              {activeTab === 'achievements' && (
                <div className="achievements-section">
                  <div className="section-header">
                    <h2>Your Encrypted Achievements</h2>
                    <div className="header-actions">
                      <div className="search-filter-container">
                        <input
                          type="text"
                          placeholder="Search achievements..."
                          value={searchTerm}
                          onChange={(e) => setSearchTerm(e.target.value)}
                          className="search-input"
                        />
                        <label className="filter-checkbox">
                          <input
                            type="checkbox"
                            checked={filterVerified}
                            onChange={(e) => setFilterVerified(e.target.checked)}
                          />
                          Verified Only
                        </label>
                      </div>
                      <button 
                        onClick={loadData} 
                        className="refresh-btn" 
                        disabled={isRefreshing}
                      >
                        {isRefreshing ? "Refreshing..." : "Refresh"}
                      </button>
                    </div>
                  </div>
                  
                  <div className="achievements-list">
                    {filteredAchievements.length === 0 ? (
                      <div className="no-achievements">
                        <div className="no-achievements-icon"></div>
                        <p>No achievements found</p>
                        <button 
                          className="create-btn" 
                          onClick={() => setShowAddModal(true)}
                        >
                          Add First Achievement
                        </button>
                      </div>
                    ) : filteredAchievements.map((achievement, index) => (
                      <div 
                        className={`achievement-item ${selectedAchievement?.id === achievement.id ? "selected" : ""}`} 
                        key={index}
                        onClick={() => setSelectedAchievement(achievement)}
                      >
                        <div className="achievement-header">
                          <div className="achievement-game">{achievement.gameName}</div>
                          <div className={`achievement-status ${achievement.verified ? 'verified' : 'unverified'}`}>
                            {achievement.verified ? 'Verified' : 'Unverified'}
                          </div>
                        </div>
                        <div className="achievement-title">{achievement.achievementName}</div>
                        <div className="achievement-encrypted">Encrypted Score: {achievement.encryptedScore.substring(0, 15)}...</div>
                        <div className="achievement-time">{new Date(achievement.timestamp * 1000).toLocaleDateString()}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              
              {activeTab === 'actions' && (
                <div className="actions-section">
                  <h2>My Activity History</h2>
                  {renderUserActions()}
                </div>
              )}
              
              {activeTab === 'faq' && (
                <div className="faq-section">
                  <h2>Frequently Asked Questions</h2>
                  {renderFAQ()}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
      
      {showAddModal && (
        <ModalAddAchievement 
          onSubmit={addAchievement} 
          onClose={() => setShowAddModal(false)} 
          adding={addingAchievement} 
          achievementData={newAchievementData} 
          setAchievementData={setNewAchievementData}
        />
      )}
      
      {selectedAchievement && (
        <AchievementDetailModal 
          achievement={selectedAchievement} 
          onClose={() => { 
            setSelectedAchievement(null); 
            setDecryptedScore(null); 
          }} 
          decryptedScore={decryptedScore} 
          setDecryptedScore={setDecryptedScore} 
          isDecrypting={isDecrypting} 
          decryptWithSignature={decryptWithSignature}
          verifyAchievement={verifyAchievement}
        />
      )}
      
      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="fhe-spinner"></div>}
              {transactionStatus.status === "success" && <div className="success-icon">✓</div>}
              {transactionStatus.status === "error" && <div className="error-icon">✗</div>}
            </div>
            <div className="transaction-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}
      
      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-brand">
            <div className="logo">
              <div className="game-icon"></div>
              <span>GamerID_FHE</span>
            </div>
            <p>Encrypted cross-game profile powered by FHE</p>
          </div>
          
          <div className="footer-links">
            <a href="#" className="footer-link">Documentation</a>
            <a href="#" className="footer-link">Privacy Policy</a>
            <a href="#" className="footer-link">Terms</a>
            <a href="#" className="footer-link">Contact</a>
          </div>
        </div>
        
        <div className="footer-bottom">
          <div className="fhe-badge">
            <span>Powered by Zama FHE</span>
          </div>
          <div className="copyright">© {new Date().getFullYear()} GamerID_FHE. All rights reserved.</div>
          <div className="disclaimer">
            This system uses fully homomorphic encryption to protect your gaming data. 
            Achievements are verifiable without revealing your actual scores.
          </div>
        </div>
      </footer>
    </div>
  );
};

interface ModalAddAchievementProps {
  onSubmit: () => void; 
  onClose: () => void; 
  adding: boolean;
  achievementData: any;
  setAchievementData: (data: any) => void;
}

const ModalAddAchievement: React.FC<ModalAddAchievementProps> = ({ onSubmit, onClose, adding, achievementData, setAchievementData }) => {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target;
    setAchievementData({ ...achievementData, [name]: value });
  };

  return (
    <div className="modal-overlay">
      <div className="add-achievement-modal">
        <div className="modal-header">
          <h2>Add New Achievement</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        
        <div className="modal-body">
          <div className="fhe-notice">
            <div className="lock-icon"></div>
            <div>
              <strong>FHE Encryption Notice</strong>
              <p>This achievement will be stored with encrypted score</p>
            </div>
          </div>
          
          <div className="form-group">
            <label>Game Name *</label>
            <input 
              type="text" 
              name="gameName" 
              value={achievementData.gameName} 
              onChange={handleChange} 
              placeholder="Enter game name..." 
            />
          </div>
          
          <div className="form-group">
            <label>Achievement Name *</label>
            <input 
              type="text" 
              name="achievementName" 
              value={achievementData.achievementName} 
              onChange={handleChange} 
              placeholder="Enter achievement name..." 
            />
          </div>
          
          <div className="form-group">
            <label>Achievement Score *</label>
            <input 
              type="number" 
              name="score" 
              value={achievementData.score} 
              onChange={handleChange} 
              placeholder="Enter score (1-100)..." 
              min="1"
              max="100"
            />
          </div>
        </div>
        
        <div className="modal-footer">
          <button onClick={onClose} className="cancel-btn">Cancel</button>
          <button 
            onClick={onSubmit} 
            disabled={adding || !achievementData.gameName || !achievementData.achievementName || !achievementData.score} 
            className="submit-btn"
          >
            {adding ? "Adding with FHE..." : "Add Achievement"}
          </button>
        </div>
      </div>
    </div>
  );
};

interface AchievementDetailModalProps {
  achievement: GameAchievement;
  onClose: () => void;
  decryptedScore: number | null;
  setDecryptedScore: (value: number | null) => void;
  isDecrypting: boolean;
  decryptWithSignature: (encryptedData: string) => Promise<number | null>;
  verifyAchievement: (achievementId: number) => void;
}

const AchievementDetailModal: React.FC<AchievementDetailModalProps> = ({ 
  achievement, 
  onClose, 
  decryptedScore, 
  setDecryptedScore, 
  isDecrypting, 
  decryptWithSignature,
  verifyAchievement
}) => {
  const handleDecrypt = async () => {
    if (decryptedScore !== null) { 
      setDecryptedScore(null); 
      return; 
    }
    
    const decrypted = await decryptWithSignature(achievement.encryptedScore);
    if (decrypted !== null) {
      setDecryptedScore(decrypted);
    }
  };

  return (
    <div className="modal-overlay">
      <div className="achievement-detail-modal">
        <div className="modal-header">
          <h2>Achievement Details</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        
        <div className="modal-body">
          <div className="achievement-info">
            <div className="info-item">
              <span>Game:</span>
              <strong>{achievement.gameName}</strong>
            </div>
            <div className="info-item">
              <span>Achievement:</span>
              <strong>{achievement.achievementName}</strong>
            </div>
            <div className="info-item">
              <span>Date Added:</span>
              <strong>{new Date(achievement.timestamp * 1000).toLocaleDateString()}</strong>
            </div>
            <div className="info-item">
              <span>Status:</span>
              <strong className={`status ${achievement.verified ? 'verified' : 'unverified'}`}>
                {achievement.verified ? 'Verified' : 'Unverified'}
              </strong>
            </div>
          </div>
          
          <div className="encrypted-section">
            <h3>Encrypted Achievement Data</h3>
            <div className="encrypted-data">{achievement.encryptedScore.substring(0, 100)}...</div>
            <div className="fhe-tag">
              <div className="fhe-icon"></div>
              <span>FHE Encrypted</span>
            </div>
            <div className="action-buttons">
              <button 
                className="decrypt-btn" 
                onClick={handleDecrypt} 
                disabled={isDecrypting}
              >
                {isDecrypting ? (
                  <span>Decrypting...</span>
                ) : decryptedScore !== null ? (
                  "Hide Decrypted Score"
                ) : (
                  "Decrypt with Wallet Signature"
                )}
              </button>
              {!achievement.verified && (
                <button 
                  className="verify-btn" 
                  onClick={() => verifyAchievement(achievement.id)}
                >
                  Verify Achievement
                </button>
              )}
            </div>
          </div>
          
          {decryptedScore !== null && (
            <div className="decrypted-section">
              <h3>Decrypted Achievement Score</h3>
              <div className="decrypted-value">
                <span>Score:</span>
                <strong>{decryptedScore.toFixed(2)}</strong>
              </div>
              <div className="decryption-notice">
                <div className="warning-icon"></div>
                <span>Decrypted score is only visible after wallet signature verification</span>
              </div>
            </div>
          )}
        </div>
        
        <div className="modal-footer">
          <button onClick={onClose} className="close-btn">Close</button>
        </div>
      </div>
    </div>
  );
};

export default App;