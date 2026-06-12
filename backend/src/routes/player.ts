import { Router } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import {
  getPlayerProfile,
} from '../services/playerService';
import {
  claimOfflineIdleRewards,
} from '../services/offlineService';

const router = Router();

// 获取玩家完整信息
router.get('/profile', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.user?.userId;

    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const profile = await getPlayerProfile(userId);

    if (!profile) {
      res.status(404).json({ error: 'Player not found' });
      return;
    }

    res.json(profile);
  } catch (error) {
    console.error('Error fetching player profile:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 离线收益结算
router.post('/offline-claim', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.user?.userId;

    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    // 离线收益只能由真实 idle_tasks 结算，不再按 last_offline 凭空发放资源
    const claimResult = await claimOfflineIdleRewards(userId);
    if (!claimResult) {
      res.status(404).json({ error: 'Player not found' });
      return;
    }

    res.json({
      success: true,
      data: {
        offlineTime: claimResult.offlineTime,
        taskCount: claimResult.taskCount,
        earned: claimResult.earned,
        stored: claimResult.stored,
        overflowed: claimResult.overflowed,
        lastOffline: claimResult.lastOffline,
      },
    });
  } catch (error) {
    console.error('Error claiming offline earnings:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
